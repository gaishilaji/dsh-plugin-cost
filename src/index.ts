/**
 * dsh-plugin-cost —— DeepSeek 对话消费追踪（宿主半身）
 *
 * 把每个会话的 token 用量与费用聚合成一个 projection（键名 'cost'），
 * 浏览器半身（src/client/）通过 useProjection('cost') 读取并渲染：
 *   - 每条助手消息的费用（展示在消息操作条，与"耗时/tok/s"同排）
 *   - 本会话总消费（展示在输入框下方的读数带）
 *
 * 计费口径（DeepSeek 官方，https://api-docs.deepseek.com/zh-cn/quick_start/pricing/）：
 *   - usage 字段为 disjoint 计数：inputTokens = 未命中缓存输入，
 *     cacheReadTokens = 命中缓存输入，outputTokens = 输出
 *     （llm-deepseek adapter：cache reads subtracted out of inputTokens）。
 *   - 费用 = 未命中输入×miss价 + 命中输入×hit价 + 输出×output价（每百万 token）。
 *   - 分时定价：高峰（北京时间周一至周五 9:00–12:00、14:00–18:00）为刊例价，
 *     空闲时段为高峰价的一半。按每条消息发生时刻（event.time）判断，可重放、幂等。
 *   - 单价做成 config（无硬编码部署参数），价格变动只改 cordis.yml 即可。
 *
 * @module dsh-plugin-cost
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { z } from 'zod'
// Type-only：让 SessionProjectionStateMap / SessionProjectionMap 认识 'cost' 键
// （编译期擦除，不产生运行时依赖）。
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'dsh-plugin-cost'

/** 需要宿主侧的 sessionProjections 服务（dsh-base 内置）。 */
export const inject = ['sessionProjections']

// ============================================================================
// 默认价格表（高峰时段刊例价，元 / 百万 tokens）
// 来源：DeepSeek API 文档《模型 & 价格》（2026-08 快照）
//   deepseek-v4-flash            输入 命中 0.05~0.10 / 未命中 1.5~3.0 / 输出 4.5~9.0
//   deepseek-v4-pro              输入 命中 0.15~0.30 / 未命中 4.5~9.0 / 输出 13.5~27.0
//   deepseek-v4-flash-vision-exp 同 flash
// 存高峰价，空闲时段运行时自动按 0.5 折算。
// ============================================================================
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'deepseek-v4-flash': { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 },
  'deepseek-v4-pro': { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 },
  'deepseek-v4-flash-vision-exp': { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 },
}

/** 单个模型的单价（高峰价，元 / 百万 tokens）。 */
export interface ModelPrice {
  /** 缓存命中的输入单价。 */
  cacheHit: number
  /** 缓存未命中的输入单价。 */
  cacheMiss: number
  /** 输出单价。 */
  output: number
}

/** 插件配置：价格可被 cordis.yml 覆盖（价格变动无需改代码）。 */
export interface Config {
  /** 按模型名 → 高峰价。key 与 assistant message 的 model 匹配。 */
  prices: Record<string, ModelPrice>
  /** 峰谷策略：auto=按事件发生时刻的北京时间自动判断；peak=恒按高峰；off-peak=恒按空闲。 */
  peakMode: 'auto' | 'peak' | 'off-peak'
  /** message 未带 model 时兜底使用的模型名。 */
  defaultModel: string
  /** 每轮消费限额（默认关闭；可在 Web 设置里改，双份源：schema 默认 + user 层覆盖）。 */
  budget: BudgetConfig
}

/** 每轮消费限额配置。mode 保留给后续的"超限询问"档位；当前实现只走 'warn'。 */
export interface BudgetConfig {
  /** 是否启用每轮限额。 */
  enabled: boolean
  /** 每轮消费上限（元）。 */
  perTurn: number
  /** 超限行为：'warn'=仅提示（当前）；'ask' 预留。 */
  mode: 'warn' | 'ask'
}

/** 下发到浏览器的限额视图（wire view 附加字段，读取当前生效值）。 */
export interface BudgetView extends BudgetConfig {}

/** Web 设置 section 的扁平字段（settingsScope 只支持单段字段路径）。 */
export interface BudgetSection {
  enabled: boolean
  perTurn: number
}

/** Web 设置里限额的命名空间。 */
export const COST_NS = settingsNamespace('dsh-plugin-cost')

const budgetSectionSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  perTurn: Schema.number().min(0).default(1),
})

export const Config: Schema<Config> = Schema.object({
  prices: Schema.dict(Schema.object({
    cacheHit: Schema.number().min(0),
    cacheMiss: Schema.number().min(0),
    output: Schema.number().min(0),
  })).default(DEFAULT_PRICES),
  peakMode: Schema.union(['auto', 'peak', 'off-peak']).default('auto'),
  defaultModel: Schema.string().default('deepseek-v4-flash'),
  budget: Schema.object({
    enabled: Schema.boolean().default(false),
    perTurn: Schema.number().min(0).default(1),
    mode: Schema.union(['warn', 'ask']).default('warn'),
  }).default({ enabled: false, perTurn: 1, mode: 'warn' }),
})

// ============================================================================
// 峰谷判断与费用计算（导出为纯函数，smoke 测试直接验证）
// ============================================================================

/**
 * 是否处于高峰时段：北京时间周一至周五 9:00–12:00、14:00–18:00。
 * @param date - 事件发生时刻（毫秒级 epoch 或 Date）。
 */
export function isPeakHour(date: Date | number = new Date()): boolean {
  const ms = typeof date === 'number' ? date : date.getTime()
  // 转北京时间：UTC + 8h，然后读 UTC 字段即为北京时间。
  const bj = new Date(ms + 8 * 3600_000)
  const day = bj.getUTCDay() // 0=周日
  if (day === 0 || day === 6) return false
  const h = bj.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/** 一次请求的用量明细（disjoint 计数，来自 usage 桶）。 */
export interface UsageCost {
  /** 缓存未命中输入 token 数。 */
  input: number
  /** 缓存命中输入 token 数。 */
  cacheRead: number
  /** 输出 token 数。 */
  output: number
  /** 估算费用（元，人民币）。 */
  cost: number
  /** 该请求发生在高峰时段。 */
  peak: boolean
}

/**
 * 按单价表计算一次请求的费用。
 * @param input - 未命中输入 token。
 * @param cacheRead - 命中输入 token。
 * @param output - 输出 token。
 * @param prices - 该模型的【高峰】单价（元/百万）。
 * @param peak - 是否高峰；false 时按半价。
 */
export function computeCost(
  input: number,
  cacheRead: number,
  output: number,
  prices: ModelPrice,
  peak: boolean,
): UsageCost {
  const rate = peak ? 1 : 0.5
  const cost = (
    input / 1e6 * prices.cacheMiss
    + cacheRead / 1e6 * prices.cacheHit
    + output / 1e6 * prices.output
  ) * rate
  return { input, cacheRead, output, cost, peak }
}

/** 从 usage 桶取数（llm-deepseek 的 disjoint 语义：inputTokens 不含缓存读）。 */
function usageBuckets(usage: {
  inputTokens: number
  cacheReadTokens?: number
  outputTokens: number
}): { input: number; cacheRead: number; output: number } {
  return {
    input: usage.inputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    output: usage.outputTokens,
  }
}

// ============================================================================
// projection：每条消息的用量/费用 + 会话累计
// ============================================================================

/** 单条消息的费用明细（浏览器侧会读这个形状）。 */
export interface CostMessage {
  input: number
  cacheRead: number
  output: number
  cost: number
  peak: boolean
  model: string
  /** 该消息所属的轮次（assistant/message 事件的 data.turn）。 */
  turn: number
  /** 该消息在轮次内的步序（data.step），用于按轮分组后保持稳定顺序。 */
  step: number
  /** 消息发生时刻（事件 time，epoch ms），用于详情里的时间展示。 */
  time: number
  /** 内容里是否含可见文本（纯工具调用步骤为 false）。 */
  text: boolean
  /** 内容里 tool-call 的工具名列表（并行调用多个工具时 >1）。 */
  tools: string[]
}

/** 会话累计。 */
export interface CostTotals {
  input: number
  cacheRead: number
  output: number
  cost: number
  messages: number
}

/** projection 的宿主状态。 */
export interface CostState {
  totals: CostTotals
  messages: Record<string, CostMessage>
  /** 当前打开（进行中）的轮次；空闲为 null。由 turn/start、turn/end 维护。 */
  openTurn: number | null
}

const emptyTotals = (): CostTotals => ({ input: 0, cacheRead: 0, output: 0, cost: 0, messages: 0 })

const costMessageSchema = z.object({
  input: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  peak: z.boolean(),
  model: z.string(),
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  text: z.boolean(),
  tools: z.array(z.string()),
}).strict()

const costTotalsSchema = z.object({
  input: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  messages: z.number().int().nonnegative(),
}).strict()

const costStateSchema = z.object({
  totals: costTotalsSchema,
  messages: z.record(z.string(), costMessageSchema),
  openTurn: z.number().int().nonnegative().nullable(),
}).strict()

type CostStateInferred = z.infer<typeof costStateSchema>

/** wire 视图 = 宿主状态 + 当前生效的限额（随设置变更即时刷新）。 */
const costViewSchema = z.object({
  totals: costTotalsSchema,
  messages: z.record(z.string(), costMessageSchema),
  openTurn: z.number().int().nonnegative().nullable(),
  budget: z.object({
    enabled: z.boolean(),
    perTurn: z.number().nonnegative(),
    mode: z.string(),
  }).strict(),
}).strict()

/** 浏览器侧拿到的完整视图类型（状态 + 当前限额）。 */
export type CostView = z.infer<typeof costViewSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    cost: CostStateInferred
  }
  interface SessionProjectionMap {
    cost: CostView
  }
}

/** 组装投影单元：apply 为纯 fold，闭包只引用启动期确定的 config。
 *  `readBudget` 在每次产出 wire 视图时读取【当前生效】的限额
 *  （Web 设置保存后无需重启即反映到浏览器）。导出以便测试。 */
export function makeProjection(config: Config, readBudget: () => BudgetView = () => config.budget) {
  const fallbackModel = config.defaultModel
  const isPeak = (time: number): boolean => {
    if (config.peakMode === 'peak') return true
    if (config.peakMode === 'off-peak') return false
    return isPeakHour(time)
  }

  return {
    key: 'cost',
    stateVersion: 3,
    stateSchema: costStateSchema,
    init: (): CostStateInferred => ({ totals: emptyTotals(), messages: {}, openTurn: null }),
    apply: (state: CostStateInferred, event: SessionEvent): CostStateInferred => {
      // 轮次边界：turn/start 打开当前轮、turn/end 关闭。维护 openTurn 除了
      // 给"本轮"显示提供语义，也让轮次切换时产生新的状态引用、从而把
      // 最新的限额（view 附加字段）随帧推给浏览器。
      if (event.type === 'turn/start') {
        if (state.openTurn === event.data.turn) return state
        return { ...state, openTurn: event.data.turn }
      }
      if (event.type === 'turn/end') {
        if (state.openTurn !== event.data.turn) return state
        return { ...state, openTurn: null }
      }
      if (event.type !== 'assistant/message' || event.data.usage === undefined) return state
      const messageId = String(event.data.message.id ?? event.seq)
      // 已在状态中的消息（重放/重复）不重复计费。
      if (state.messages[messageId] !== undefined) return state

      const { input, cacheRead, output } = usageBuckets(event.data.usage)
      // 模型名在 message.source.model（ModelMessageSource）。
      const model = event.data.message.source?.model ?? fallbackModel
      const price = config.prices[model]
      const totals = { ...state.totals }
      totals.input += input
      totals.cacheRead += cacheRead
      totals.output += output
      totals.messages += 1
      const peak = isPeak(event.time)
      const cost = price === undefined
        ? 0 // 未知模型：仍记录用量，费用按 0（价格表可配，见 README）
        : computeCost(input, cacheRead, output, price, peak).cost
      totals.cost += cost
      // 内容形状：纯工具调用步骤（无文本）没有可见气泡，但同样按 usage 计费。
      // 浏览器端按 (turn, step) 把整轮步骤聚合成"本轮 N 次调用"并展开详情。
      const content = event.data.message.content as
        | readonly { type?: string; text?: unknown; name?: unknown }[]
        | undefined
      const tools: string[] = []
      let text = false
      for (const part of content ?? []) {
        if (part?.type === 'tool-call' && typeof part.name === 'string') tools.push(part.name)
        else if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') text = true
      }
      const turn = (event.data as { turn?: number }).turn ?? 0
      const step = (event.data as { step?: number }).step ?? 0
      return {
        ...state,
        totals,
        messages: {
          ...state.messages,
          [messageId]: {
            input, cacheRead, output, cost, peak, model,
            turn, step, time: event.time, text, tools,
          },
        },
      }
    },
    wire: {
      viewSchema: costViewSchema,
      view: (state): CostView => ({ ...state, budget: readBudget() }),
    },
  } satisfies ProjectionDefinition<'cost', CostStateInferred>
}

/** 插件主体：注册投影 + 把限额接入 Web 设置（settings 服务缺席时自动跳过）。 */
export function apply(ctx: Context, config: Config) {
  console.log('[dsh-plugin-cost] 插件已加载，费用追踪开始')
  // 当前生效的限额：初始取 composition entry（cordis.patch.yml 的 config.budget）；
  // settings 服务存在时，注册 section 后由 resolved scope（base + user 层）驱动。
  const current: { budget: BudgetView } = {
    budget: { ...config.budget, mode: 'warn' },
  }
  let sectionSource: (() => BudgetSection) | null = null
  installSettingsSection(ctx, COST_NS, budgetSectionSchema, {
    enabled: config.budget.enabled,
    perTurn: config.budget.perTurn,
  }, {
    setSource: (thunk) => { sectionSource = thunk },
    onChange: () => {
      const section = sectionSource === null ? null : sectionSource()
      if (section !== null) {
        // attach/detach/每次设置写入触发：用 resolved scope（user 层覆盖 base）
        // 更新投影视图下发用的当前限额。
        current.budget = { enabled: section.enabled, perTurn: section.perTurn, mode: 'warn' }
      }
    },
  })
  ctx.sessionProjections.register(makeProjection(config, () => current.budget))
}
