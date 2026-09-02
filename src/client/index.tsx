/**
 * dsh-plugin-cost —— DeepSeek 对话消费追踪（浏览器半身）
 *
 * 读取宿主侧 projection 'cost'（见 src/index.ts），渲染两处：
 *
 *   1. conversation.chat.assistant-actions —— 每轮结束的 actions 条内
 *      （TurnTail，与内置"耗时 / TTFT / tok/s"同排）：
 *      每轮一个汇总芯片 `本轮总消费 ¥0.0987`（该轮全部模型调用合计，
 *      含纯工具调用、无文本气泡的步骤）。鼠标移上去（或点按）弹出明细浮层：
 *        - 对话费用：该轮最后那条可见回复（closing 消息）自身的费用；
 *        - 调用明细：逐条列出该轮每一步 ——
 *          #步序 时刻 文本/工具名 入·缓存读·出 tokens ¥费用；
 *        - 本轮合计。
 *      浮层可悬停（不会因光标移出芯片就消失），离开芯片与浮层后才关闭。
 *   2. conversation.composer.dock —— 输入框下方的总消费读数带（不变）。
 *
 * 轮次聚合完全来自投影状态：宿主在每条计费消息上记录 turn/step，客户端
 * 按 turn 分组，保证"所见即所扣"——浮层里列出的每一条都能在总账对上。
 *
 * 槽位注入的标准套件（PropsRuntime）会提供 useProjection / useSession /
 * sessionId；本组件不接触 ctx，数据全部来自 props。
 *
 * @module dsh-plugin-cost/client
 */

import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/** 浏览器侧插件同样声明依赖（服务名 'slots'）。 */
export const inject = ['slots']

/** 宿主 projection 'cost' 的 wire 视图（与 src/index.ts 的 CostState 一致）。 */
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
}

const fmt = (n: number): string => n.toLocaleString('zh-CN')

/** 金额格式：≥1 元两位小数，否则四位（避免出现 0.0000）。 */
function formatMoney(n: number): string {
  if (n <= 0) return '¥0'
  const fixed = n >= 1 ? n.toFixed(2) : n.toFixed(4)
  return `¥${fixed}`
}

/** 最小 props 类型（正式项目可用 PropsRuntime<'...'> 推导完整套件）。 */
interface SlotProps {
  useProjection: (key: string) => unknown
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
// 展示位 1：每轮"本轮总消费"芯片 + hover 明细浮层（对话费用 + 调用详情）
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
    color: 'var(--dsw-alias-label-secondary, #8a8f98)',
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
              <span>对话费用（本条回复 #{closing.step}）</span>
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
// 展示位 2：会话总消费（输入框下方读数带，口径不变）
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
  register: (options: { name: string; id: string; order: number }, component: unknown) => unknown
}

export function apply(ctx: { slots: unknown }): void {
  const slots = ctx.slots as Slots

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
}
