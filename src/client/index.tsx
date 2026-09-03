/**
 * dsh-plugin-cost —— DeepSeek 对话消费追踪（浏览器半身）
 *
 * 读取宿主侧 projection 'cost'（见 src/index.ts）的 wire 视图
 * （宿主状态 + 当前生效的每轮限额 budget），渲染三处：
 *
 *   1. conversation.input.dock —— 输入框上方整行区（deep-diving 所在聊天区
 *      下方、输入卡上方，运行中用户视线常驻区域）：agent 运行中显示动态
 *      `本轮 ¥0.34 / 限额 ¥1.00`，每完成一步步进更新；超限变红 + `已超本轮限额`。
 *      对话结束（空闲）自动隐藏。
 *   2. conversation.chat.assistant-actions —— 每轮结束的 actions 条内的
 *      `本轮总消费 ¥X` 汇总芯片（含纯工具调用步骤；hover 弹出明细浮层：
 *      对话费用 + 逐条调用详情 + 本轮合计）。该轮超限时芯片标红，
 *      浮层里追加"已超本轮限额"提示行。浮层可悬停，不会移出即消失。
 *   3. conversation.composer.dock —— 输入框下方总消费读数带（不变）。
 *
 * 每轮限额（budget）是双份源：cordis.patch.yml 的 config.budget 做默认/部署层，
 * Web 设置里本插件的设置卡（settings.plugin.item）写 settings.yaml user 层
 * 覆盖，宿主随投影视图下发当前生效值（设置保存后下一轮/下一步生效）。
 *
 * 槽位注入的标准套件（PropsRuntime）会提供 useProjection / useSession /
 * sessionId；本组件不接触 ctx，数据全部来自 props。
 *
 * @module dsh-plugin-cost/client
 */

import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { registerBudgetSettingsCard } from './settings-card.tsx'

/** 浏览器侧插件同样声明依赖（服务名 'slots'）。 */
export const inject = ['slots']

/** 宿主投影 'cost' 的 wire 视图（= 状态 + 当前限额，见 src/index.ts）。 */
interface CostMessage {
  input: number
  cacheRead: number
  output: number
  cost: number
  peak: boolean
  model: string
  turn: number
  step: number
  time: number
  text: boolean
  tools: string[]
}

interface CostView {
  totals: {
    input: number
    cacheRead: number
    output: number
    cost: number
    messages: number
  }
  messages: Record<string, CostMessage>
  openTurn: number | null
  live: {
    turn: number
    step: number
    chars: number
    cost: number
  } | null
  budget: {
    enabled: boolean
    perTurn: number
    mode: string
  }
}

const fmt = (n: number): string => n.toLocaleString('zh-CN')

/** 金额格式：≥1 元两位小数，否则四位（避免出现 0.0000）。 */
function formatMoney(n: number): string {
  if (n <= 0) return '¥0'
  const fixed = n >= 1 ? n.toFixed(2) : n.toFixed(4)
  return `¥${fixed}`
}

/** 限额行/警示用金额：固定两位小数（元）。 */
function formatYuan(n: number): string {
  return `¥${n.toFixed(2)}`
}

/** 主题里没有 danger 文本 token 时的兜底红。 */
const DANGER = 'var(--dsw-alias-danger, #e5484d)'

/** 最小 props 类型（正式项目可用 PropsRuntime<'...'> 推导完整套件）。 */
interface SlotProps {
  useProjection: (key: string) => unknown
  /** session 标准套件提供的钩子（仅按需读取 running 等快照字段）。 */
  useSession?: (selector: (snapshot: Record<string, unknown>) => unknown) => unknown
}

interface AssistantActionsProps extends SlotProps {
  /** assistant-actions 槽注入的 owner 数据：该消息的持久 id。 */
  messageId: string
}

/** 该条消息的内容形状标签（与宿主记录的 text/tools 对应）。 */
function kindLabel(m: CostMessage): string {
  if (m.text) return '文本'
  if (m.tools.length > 0) {
    const name = m.tools[0]
    return m.tools.length > 1 ? `工具 ${name} 等${m.tools.length}个` : `工具 ${name}`
  }
  return '推理/其它'
}

/** 时刻 → 本地 HH:MM:SS。 */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

// ---------------------------------------------------------------------------
// 展示位 1：input.dock 动态"本轮消费/限额"行（agent 运行中显示，空闲隐藏）
// ---------------------------------------------------------------------------

export const LiveBudgetLine = memo(function LiveBudgetLine({ useProjection, useSession }: SlotProps) {
  const running = useSession?.(s => s.running) === true
  const view = useProjection('cost') as CostView | undefined
  // 运行中 + 已启用限额才显示；空闲自动隐藏（本区域无内容时不占位）。
  if (!running || view === undefined || !view.budget.enabled) return null
  // 当前轮：优先用宿主维护的 openTurn（turn/start 到 turn/end 之间）；
  // 兜底取已入账消息的最新轮。
  let turn = view.openTurn
  if (turn === null) {
    for (const m of Object.values(view.messages)) {
      if (turn === null || m.turn > turn) turn = m.turn
    }
    if (turn === null) return null
  }
  // 该轮已入账消息的费用合计（agent 每完成一步更新一次，步进式增长）+
  // 当前流式步骤的输出估算（宿主按已流出的字符估算，assistant/message 落账
  // 后由真实 usage 顶替）。估算只影响运行中的读数，最终显示都用精确值。
  let spend = 0
  for (const m of Object.values(view.messages)) {
    if (m.turn === turn) spend += m.cost
  }
  const live = view.live
  const estimating = live !== null && live.turn === turn && live.cost > 0
  if (estimating) spend += live.cost
  const over = spend > view.budget.perTurn
  const color = over ? DANGER : 'var(--dsw-alias-label-secondary, #8a8f98)'
  // 流式估算的增量是万分位级别：两位小数会一直显示 ¥0.00，观感断裂。
  // 运行中（含估算）用 4 位小数，让读数随思考实时动；停滞后回到两位。
  const spendText = estimating || spend < 0.005 ? `¥${spend.toFixed(4)}` : formatYuan(spend)
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        // 与 todo/queue 等 input.dock 卡片一致的水平几何：相对聊天内容列
        // （--dsh-chat-content-width）居中，而不是从区域最左缘起。
        boxSizing: 'border-box',
        margin: '0 auto',
        width: 'calc(100% - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
        maxWidth: 'calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
        fontSize: 12,
        lineHeight: '18px',
        color,
        fontVariantNumeric: 'tabular-nums',
        padding: '2px 0',
      }}
    >
      {over && <span aria-hidden>⚠ </span>}
      本轮 {estimating ? '≈' : ''}{spendText} / 限额 {formatYuan(view.budget.perTurn)}
      {estimating && <span style={{ opacity: 0.75, marginLeft: 6 }}>（含流式估算）</span>}
      {over && <span style={{ marginLeft: 6 }}>已超本轮限额</span>}
    </div>
  )
})

// ---------------------------------------------------------------------------
// 展示位 2：每轮"本轮总消费"芯片 + hover 明细浮层（对话费用 + 调用详情）
// ---------------------------------------------------------------------------

/** 离开芯片/浮层后关闭的容差（毫秒），避免光标在两者间移动时闪烁。 */
const HIDE_GRACE_MS = 180

export const TurnCostSummary = memo(function TurnCostSummary({ messageId, useProjection }: AssistantActionsProps) {
  const cost = useProjection('cost') as CostView | undefined
  const closing = cost?.messages[messageId]
  // 浮层锚点与开关。
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ x: number; top: number; bottom: number } | null>(null)
  const [placement, setPlacement] = useState<'bottom' | 'top'>('bottom')
  const chipRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 固定定位浮层的视口适配：左缘锚定并夹回视口内；底部放不下、上方放得下
  // 时翻到上方（两侧都放不下时保持请求侧，避免来回翻转）。
  const MARGIN = 8
  useLayoutEffect(() => {
    if (!open || anchor === null) return
    const el = panelRef.current
    /* v8 ignore next -- anchor 只在面板挂载期间非空。 */
    if (el === null) return
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.min(Math.max(anchor.x, MARGIN), window.innerWidth - r.width - MARGIN)}px`
    if (placement === 'bottom') {
      el.style.top = `${anchor.bottom + 6}px`
      const fitsBelow = anchor.bottom + 6 + r.height <= window.innerHeight - MARGIN
      const fitsAbove = anchor.top - 6 - r.height >= MARGIN
      if (!fitsBelow && fitsAbove) setPlacement('top')
    } else {
      el.style.top = `${anchor.top - 6 - r.height}px`
      const fitsAbove = anchor.top - 6 - r.height >= MARGIN
      const fitsBelow = anchor.bottom + 6 + r.height <= window.innerHeight - MARGIN
      if (!fitsAbove && fitsBelow) setPlacement('bottom')
    }
  }, [open, anchor, placement])

  // 整轮步骤：按 turn 分组、step 排序（无 usage 的消息不在 messages 里）。
  if (cost === undefined || closing === undefined || closing.turn === 0) return null
  const steps = Object.values(cost.messages)
    .filter(m => m.turn === closing.turn)
    .sort((a, b) => a.step - b.step || a.time - b.time)
  if (steps.length === 0) return null

  const totalCost = steps.reduce((s, m) => s + m.cost, 0)
  const totalInput = steps.reduce((s, m) => s + m.input, 0)
  const totalRead = steps.reduce((s, m) => s + m.cacheRead, 0)
  const totalOut = steps.reduce((s, m) => s + m.output, 0)
  const models = new Set(steps.map(m => m.model))
  const modelLine = models.size === 1 ? [...models][0] : [...models].join(' / ')
  // closing 消息是"本条回复"（动作条所属的那条可见消息）。
  const dialogue = closing.cost
  const overBudget = cost.budget.enabled && totalCost > cost.budget.perTurn
  const overLimitNote = overBudget ? `（限额 ${formatYuan(cost.budget.perTurn)}）` : ''

  const cancelHide = () => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }
  const scheduleHide = () => {
    cancelHide()
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null
      setOpen(false)
      setAnchor(null)
    }, HIDE_GRACE_MS)
  }
  const show = () => {
    cancelHide()
    const el = chipRef.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    setPlacement('bottom')
    setAnchor({ x: r.left, top: r.top, bottom: r.bottom })
    setOpen(true)
  }
  const hideNow = () => {
    cancelHide()
    setOpen(false)
    setAnchor(null)
  }

  const chipStyle: CSSProperties = {
    cursor: 'help',
    color: overBudget ? DANGER : 'var(--dsw-alias-label-secondary, #8a8f98)',
    fontVariantNumeric: 'tabular-nums',
  }
  const panelStyle: CSSProperties = {
    position: 'fixed',
    zIndex: 300,
    width: 460,
    maxWidth: `min(92vw, 460px)`,
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: 10,
    background: 'var(--dsw-alias-tooltip-bg, #23272e)',
    color: 'var(--dsw-static-neutral-bluish-00, #f5f6f8)',
    boxShadow: '0 8px 24px rgba(0,0,0,.28)',
    fontVariantNumeric: 'tabular-nums',
    // 浮层可命中：光标移到卡片上不关闭（与芯片同属一个 hover 子树，见外层
    // onMouseLeave 的容差逻辑）。
    pointerEvents: 'auto',
    whiteSpace: 'normal',
    overflowWrap: 'break-word',
  }
  const sep: CSSProperties = {
    borderTop: '1px solid rgba(255,255,255,.1)',
    margin: '5px 0',
  }

  return (
    <span
      ref={chipRef}
      style={chipStyle}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
      onClick={open ? hideNow : show}
    >
      {overBudget && <span aria-hidden>⚠ </span>}
      本轮总消费 {formatMoney(totalCost)}
      {open && anchor !== null && (
        <div
          ref={panelRef}
          style={panelStyle}
          role="tooltip"
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          <div style={{ fontSize: 12, lineHeight: '18px', opacity: 0.85 }}>
            第 {closing.turn} 轮 · {steps.length} 次模型调用 · {modelLine}
          </div>
          {overBudget && (
            <div style={{ fontSize: 12, lineHeight: '18px', marginTop: 2, color: DANGER }}>
              ⚠ 已超本轮限额 {formatYuan(cost.budget.perTurn)}
            </div>
          )}
          {steps.length > 1 && dialogue > 0 && (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: 12,
                lineHeight: '18px',
                marginTop: 4,
              }}
            >
              <span>对话费用（本条回复 #{closing.step}）{overLimitNote}</span>
              <span style={{ opacity: 0.85 }}>{formatMoney(dialogue)}</span>
            </div>
          )}
          <div style={sep} />
          <div style={{ fontSize: 12, lineHeight: '16px', opacity: 0.75, marginBottom: 2 }}>
            调用明细（{steps.length} 次）
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {steps.map(m => {
              const isClosing = m.step === closing.step && m.time === closing.time
              return (
                <div
                  key={`${m.turn}-${m.step}-${m.time}`}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    fontSize: 12,
                    lineHeight: '20px',
                    borderTop: '1px solid rgba(255,255,255,.08)',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    #{m.step} {clock(m.time)} {kindLabel(m)}
                    {isClosing && <span style={{ opacity: 0.65 }}>（本条回复）</span>}
                    <span style={{ opacity: 0.7 }}>
                      {' '}
                      入{fmt(m.input)}·缓存读{fmt(m.cacheRead)}·出{fmt(m.output)}
                    </span>
                  </span>
                  <span style={{ flexShrink: 0, opacity: m.cost > 0 ? 1 : 0.5 }}>
                    {formatMoney(m.cost)}
                  </span>
                </div>
              )
            })}
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 8,
              fontSize: 12,
              lineHeight: '18px',
              marginTop: 4,
              borderTop: '1px solid rgba(255,255,255,.14)',
              paddingTop: 4,
            }}
          >
            <span>
              本轮合计 · 入 {fmt(totalInput)} · 缓存读 {fmt(totalRead)} · 出 {fmt(totalOut)}
            </span>
            <strong>{formatMoney(totalCost)}</strong>
          </div>
        </div>
      )}
    </span>
  )
})

// ---------------------------------------------------------------------------
// 展示位 3：会话总消费（输入框下方读数带，口径不变）
// ---------------------------------------------------------------------------

export const CostTotalBar = memo(function CostTotalBar({ useProjection }: SlotProps) {
  const cost = useProjection('cost') as CostView | undefined
  if (cost === undefined || cost.totals.messages === 0) {
    return (
      <span style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #8a8f98)' }}>
        消费统计：等待数据…
      </span>
    )
  }
  const t = cost.totals
  return (
    <span
      title={`${t.messages} 条模型消息 · 输入 ${fmt(t.input)}（缓存读 ${fmt(t.cacheRead)}）· 输出 ${fmt(t.output)}`}
      style={{
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary, #8a8f98)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      总消费 {formatMoney(t.cost)} · 输入 {fmt(t.input + t.cacheRead)} · 输出 {fmt(t.output)}
    </span>
  )
})

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/** 浏览器侧 slots API 的最小类型（正式项目按官方类型声明）。 */
interface Slots {
  inject: (name: string, register: () => unknown) => void
  register: (options: {
    name: string
    key?: string
    id?: string
    order?: number
    inject?: () => Record<string, unknown>
  }, component: unknown) => unknown
}

/** 客户端 ctx 的最小形状（只用到 slots + 可选服务注入）。 */
interface ClientCtxLike {
  slots: unknown
  get?: (name: string) => unknown
  /** cordis 服务注入：服务就绪后调用回调（浏览器插件的 apply 顺序无约束）。 */
  inject?: (services: readonly string[], callback: (sctx: Record<string, unknown>) => unknown) => unknown
}

export function apply(ctx: ClientCtxLike): void {
  const slots = ctx.slots as Slots

  // 输入框上方整行区：运行中动态"本轮消费/限额"行。
  slots.inject('conversation.input.dock', () =>
    slots.register({
      name: 'conversation.input.dock',
      id: 'cost-live-budget',
      order: 5,
    }, LiveBudgetLine),
  )

  // 每轮汇总芯片（assistant-actions 只在每轮 closing 的 actions 条渲染一次，
  // 因此这里天然是"每轮下面"的位置）：本轮总消费 + hover 明细。
  slots.inject('conversation.chat.assistant-actions', () =>
    slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'cost-turn-summary',
      order: 10,
    }, TurnCostSummary),
  )

  // 输入框下方读数带：总消费行（order 30，排在内置 StatsLine 之后）。
  slots.inject('conversation.composer.dock', () =>
    slots.register({
      name: 'conversation.composer.dock',
      id: 'cost-total',
      order: 30,
    }, CostTotalBar),
  )

  // Web 设置卡。settingsScope 由其它浏览器插件（ui-settings）提供，而浏览器
  // 插件的 apply 顺序无约束：若本插件先于它 apply，一次性 ctx.get 会拿到
  // undefined 导致卡片永不注册。因此：
  //   1) 先尝试立即拿服务（已就绪则直接注册）；
  //   2) 再走 ctx.inject(['settingsScope'], …) 等服务就绪补注册（幂等：仅一次）。
  // 服务始终缺席（如 headless 部署）时静默跳过，不影响上面的展示。
  let registered = false
  const tryRegister = (scopeService: unknown): void => {
    if (registered) return
    try {
      if (registerBudgetSettingsCard(slots, scopeService)) registered = true
    } catch (error) {
      console.warn('[dsh-plugin-cost] 设置卡注册失败（不影响费用展示）', error)
    }
  }
  try {
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['settingsScope'], sctx => { tryRegister(sctx?.settingsScope) })
      } catch {
        // 注入不可用（旧客户端）→ 退回一次性 get
        tryRegister(ctx.get?.('settingsScope'))
      }
    } else {
      tryRegister(ctx.get?.('settingsScope'))
    }
  } catch (error) {
    console.warn('[dsh-plugin-cost] 设置卡注册异常（不影响费用展示）', error)
  }
}
