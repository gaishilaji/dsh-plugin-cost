/**
 * dsh-plugin-cost —— 每轮限额的 Web 设置卡（浏览器半侧）
 *
 * 注册进 `settings.plugin.item`（keyed，键 = settings 命名空间 'dsh-plugin-cost'），
 * 由 Plugins 分区的 configurable 标签页按"被服务的命名空间"派发渲染。
 *
 * 卡片外观与仓库内置卡（PluginCard）一致：默认折叠成一张卡（名称 + 一句说明），
 * 点击展开后在原处显示配置项与底部操作；折叠时保留未保存的草稿并在头部标记。
 * （跨插件 value-import 被纯净门禁禁止，故外观用相同样式 token 自绘。）
 *
 * 读写走宿主提供的 `settingsScope`（bind 命名空间后得到的 controller）：
 *   - getSnapshot()：resolved `value` / 组合层 `base` / 原始 user 层（key 存在
 *     即代表被 user 覆盖）；
 *   - set(field, v) / unset(field)：写 / 清 settings.yaml user 层字段；
 * 宿主侧 `installSettingsSection` 会把"保存 → user 层变更 → onChange →
 * 投影视图 budget 更新"串起来：设置保存后无需重启，下一轮/下一步即按新限额提示。
 *
 * @module dsh-plugin-cost/client/settings-card
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
// 平台 seed 词（外壳注入模块表，运行时由 loader 的 require 命中）：
// 与内置插件卡一致的展开箭头图标。
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'

/** 每轮限额 section 的扁平字段（与宿主 BudgetSection 一致）。 */
interface BudgetSectionLike {
  enabled?: boolean
  perTurn?: number
}

/** settingsScope.bind() 返回的 controller 的最小形状。 */
interface ScopeLike {
  getSnapshot: () => {
    value?: BudgetSectionLike | null
    base?: BudgetSectionLike | null
    user?: Record<string, unknown> | null
    status?: string
    writable?: boolean
  }
  subscribe: (listener: () => void) => () => void
  set: (field: string, value: boolean | number) => Promise<unknown>
  unset: (field: string) => Promise<unknown>
}

const DEFAULT_ENABLED = false
const DEFAULT_PERTURN = 1

// ---- 与仓库 PluginCard.module.css 一致的样式 token（带兜底） ----
const TOKENS = {
  cardBorder: 'var(--dsw-alias-border-l2, #2b3037)',
  cardBg: 'var(--dsw-alias-bg-layer-3, #191c21)',
  cardBgOpen: 'var(--dsw-alias-bg-layer-2, #14171c)',
  hoverBorder: 'var(--dsw-alias-label-dimmed, #565d68)',
  nameColor: 'var(--dsw-alias-label-primary, #e8eaed)',
  descColor: 'var(--dsw-alias-label-secondary, #8a8f98)',
  brand: 'var(--dsw-alias-brand-primary, #4c8dff)',
  danger: 'var(--dsw-alias-danger, #e5484d)',
} as const

const cardShell: CSSProperties = {
  listStyle: 'none',
  border: `1px solid ${TOKENS.cardBorder}`,
  borderRadius: 12,
  background: TOKENS.cardBg,
}

const headerBtn: CSSProperties = {
  width: '100%',
  appearance: 'none',
  border: 0,
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
  borderRadius: 12,
}

const headText: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const cardName: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.4,
  color: TOKENS.nameColor,
}

const cardDesc: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: TOKENS.descColor,
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '2px 16px 16px',
  fontSize: 13,
  lineHeight: '20px',
  color: TOKENS.nameColor,
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const fieldInput: CSSProperties = {
  width: 110,
  padding: '3px 8px',
  borderRadius: 6,
  border: `1px solid ${TOKENS.cardBorder}`,
  background: 'var(--dsw-alias-bg-layer-1, #101318)',
  color: 'inherit',
}

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 2,
}

const actionBtn: CSSProperties = {
  padding: '4px 14px',
  borderRadius: 8,
  fontSize: 13,
  lineHeight: '20px',
  cursor: 'pointer',
  border: `1px solid ${TOKENS.cardBorder}`,
  background: 'transparent',
  color: 'inherit',
}

const saveBtn: CSSProperties = {
  ...actionBtn,
  border: '1px solid transparent',
  background: TOKENS.brand,
  color: '#fff',
}

/** 序列化 resolved 值，用于判断快照是否被外部改动。 */
function resolvedKey(section: BudgetSectionLike): string {
  return `${section.enabled ?? DEFAULT_ENABLED}|${section.perTurn ?? DEFAULT_PERTURN}`
}

/** 摘要行：折叠态也可见的当前状态。 */
function summaryText(enabled: boolean, perTurn: number): string {
  return enabled ? `已启用 · 每轮 ¥${perTurn.toFixed(2)}` : '未启用'
}

/** 本插件在设置页的限额卡片（折叠卡片外观，与内置插件卡一致）。 */
export function BudgetSettingsCard({ scope }: { scope: ScopeLike }) {
  // useSyncExternalStore 需要稳定的订阅函数；scope.subscribe/getSnapshot 是
  // 类方法（内部访问 this.store），必须用闭包包装保留 this，不能传裸引用。
  const subscribe = (listener: () => void): (() => void) => scope.subscribe(listener)
  const getSnapshot = () => scope.getSnapshot()
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const value = snapshot.value ?? snapshot.base ?? {}
  const base = snapshot.base ?? {}
  const writable = snapshot.writable !== false && snapshot.status !== 'loading'
  const resolved = {
    enabled: value.enabled ?? base.enabled ?? DEFAULT_ENABLED,
    perTurn: value.perTurn ?? base.perTurn ?? DEFAULT_PERTURN,
  }

  const [open, setOpen] = useState(false)
  const [draftEnabled, setDraftEnabled] = useState(resolved.enabled)
  const [draftText, setDraftText] = useState(String(resolved.perTurn))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastResolved = useRef(resolvedKey(resolved))

  // 外部改动（其它入口 / 手动编辑 settings.yaml）且本地草稿未被用户改动时，
  // 跟随最新 resolved 值。
  useEffect(() => {
    const key = resolvedKey(resolved)
    if (key === lastResolved.current) return
    lastResolved.current = key
    setDraftEnabled(resolved.enabled)
    setDraftText(String(resolved.perTurn))
  }, [resolved.enabled, resolved.perTurn])

  const draftPerTurn = Number(draftText)
  const draftValid = Number.isFinite(draftPerTurn) && draftPerTurn >= 0
  const dirty = draftEnabled !== resolved.enabled
    || (!draftValid || draftPerTurn !== resolved.perTurn)

  const commit = async (enabled: boolean, perTurn: number): Promise<void> => {
    // user 层只在"与组合层不同"时写入；相同则 unset 回落到 composition。
    const writes: Promise<unknown>[] = []
    if (enabled === (base.enabled ?? DEFAULT_ENABLED)) writes.push(scope.unset('enabled'))
    else writes.push(scope.set('enabled', enabled))
    if (perTurn === (base.perTurn ?? DEFAULT_PERTURN)) writes.push(scope.unset('perTurn'))
    else writes.push(scope.set('perTurn', perTurn))
    await Promise.all(writes)
  }

  const onSave = async (): Promise<void> => {
    if (!draftValid || saving) return
    setSaving(true)
    setError(null)
    try {
      await commit(draftEnabled, draftPerTurn)
    } catch (cause) {
      setError(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setSaving(false)
    }
  }

  const onReset = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await Promise.all([scope.unset('enabled'), scope.unset('perTurn')])
      setDraftEnabled(base.enabled ?? DEFAULT_ENABLED)
      setDraftText(String(base.perTurn ?? DEFAULT_PERTURN))
    } catch (cause) {
      setError(`恢复失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setSaving(false)
    }
  }

  if (snapshot.status === 'loading') {
    return (
      <div style={{ ...cardShell, padding: '14px 16px', color: TOKENS.descColor, fontSize: 13 }}>
        限额设置加载中…
      </div>
    )
  }

  const body = (): ReactNode => (
    <div style={bodyStyle}>
      <label style={{ ...rowStyle, cursor: writable ? 'pointer' : 'not-allowed' }}>
        <input
          type="checkbox"
          checked={draftEnabled}
          disabled={!writable}
          onChange={event => { setDraftEnabled(event.target.checked); setError(null) }}
        />
        启用每轮消费限额
      </label>
      <label style={rowStyle}>
        每轮限额（元）
        <input
          type="number"
          min={0}
          step={0.1}
          value={draftText}
          disabled={!writable}
          onChange={event => { setDraftText(event.target.value); setError(null) }}
          style={fieldInput}
        />
        {!draftValid && (
          <span style={{ color: TOKENS.danger }}>请输入 ≥0 的金额</span>
        )}
      </label>
      <div style={{ fontSize: 12, lineHeight: '18px', color: TOKENS.descColor }}>
        超限行为：仅提示。agent 运行中会在聊天区下方显示“本轮 x / 限额 y”（超限变红）；
        每轮结束后“本轮总消费”芯片标红并注明超限。保存后下一轮生效，无需重启。
      </div>
      {error !== null && <div style={{ color: TOKENS.danger }}>{error}</div>}
      <div style={footerStyle}>
        <button
          type="button"
          style={actionBtn}
          disabled={!writable || saving || !dirty}
          onClick={() => void onReset()}
        >
          恢复默认
        </button>
        <button
          type="button"
          style={saveBtn}
          disabled={!writable || saving || !dirty || !draftValid}
          onClick={() => void onSave()}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )

  return (
    <div
      style={{
        ...cardShell,
        background: open ? TOKENS.cardBgOpen : TOKENS.cardBg,
        borderColor: open ? TOKENS.hoverBorder : TOKENS.cardBorder,
      }}
      onMouseEnter={event => { event.currentTarget.style.borderColor = TOKENS.hoverBorder }}
      onMouseLeave={event => {
        if (!open) event.currentTarget.style.borderColor = TOKENS.cardBorder
      }}
    >
      <button
        type="button"
        style={headerBtn}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span style={headText}>
          <span style={cardName}>dsh-plugin-cost（对话消费追踪）</span>
          <span style={cardDesc}>
            每轮消费限额 · {summaryText(resolved.enabled, resolved.perTurn)}
            {writable ? '' : ' · 只读'}
          </span>
        </span>
        {dirty ? (
          <span
            style={{
              fontSize: 12,
              lineHeight: '18px',
              color: 'var(--dsw-alias-warning, #e8a33d)',
              flexShrink: 0,
            }}
          >
            未保存
          </span>
        ) : null}
        <span
          style={{
            display: 'inline-flex',
            color: TOKENS.descColor,
            transform: open ? 'rotate(180deg)' : undefined,
            transition: 'transform .16s ease',
            flexShrink: 0,
          }}
          aria-hidden
        >
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open ? body() : null}
    </div>
  )
}

/** 注册入口：settingsScope 服务缺席时静默跳过，不影响其它展示。 */
export interface BudgetSettingsSlots {
  inject: (name: string, register: () => unknown) => void
  register: (options: {
    name: string
    key?: string
    inject?: () => Record<string, unknown>
  }, component: unknown) => unknown
}

/** 传入 settingsScope 服务本身（bind 可用时才注册卡片）。返回是否注册成功。 */
export function registerBudgetSettingsCard(
  slots: BudgetSettingsSlots,
  scopeService: unknown,
): boolean {
  const service = scopeService as { bind?: (spec: { namespace: string }) => unknown } | undefined
  if (service === undefined || typeof service.bind !== 'function') return false
  const scope = service.bind({ namespace: 'dsh-plugin-cost' }) as ScopeLike
  slots.inject('settings.plugin.item', () =>
    slots.register({
      name: 'settings.plugin.item',
      key: 'dsh-plugin-cost',
      inject: () => ({ scope }),
    }, BudgetSettingsCard),
  )
  return true
}
