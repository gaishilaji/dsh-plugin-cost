/**
 * dsh-plugin-cost —— 每轮限额的 Web 设置页（浏览器半侧）
 *
 * dsh 0.2 起，插件设置不再由插件自己注册 section（`installSettingsSection`
 * 已移除），而是由 Loader 条目的 Config schema 投影成表单，浏览器侧通过
 * `ctx.configForms.get(entryId)` 读写该条目。本组件注册进 Plugins 页的
 * `plugins.bundle.config`（keyed，键 = 包名 `dsh-plugin-cost`），渲染在
 * 本包详情页的描述与组件列表之间。
 *
 * 宿主 Config 里整个 `budget` 段声明为 volatile：
 *   - 保存走 `form.mutate([{op:'set', path:['budget','enabled'], …}], revision)`，
 *     宿主校验完整 Config 后由 ConfigEditor 写入 profile 的 cordis.patch.yml；
 *   - Loader 原地更新 volatile 配置引用，宿主投影 wire 视图时读到新限额，
 *     不需要重启，也不需要旧版的 settingsScope/settings.yaml 通道。
 *
 * 与组合层（cordis.patch.yml）相同的值用 unset 清除 user 覆盖层，
 * 让字段重新继承组合层默认值。
 *
 * @module dsh-plugin-cost/client/settings-card
 */

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'

/** 一个字段的写/清操作（与 SettingsPathOpView 同形）。 */
export interface BudgetOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

/** configForms.get(entryId) 返回的 controller 最小形状。 */
export interface BudgetFormLike {
  getSnapshot: () => BudgetFormSnapshot
  subscribe: (listener: () => void) => () => void
  mutate: (ops: readonly BudgetOp[], expectedRevision?: number) => Promise<boolean>
}

/** form 解析后的本 namespace 配置段（只有 volatile 字段会进表单）。 */
export interface BudgetFormValues {
  budget?: {
    enabled?: boolean
    perTurn?: number
  }
}

/** 一个配置表单的同步快照（与 ConfigFormSnapshot 同形）。 */
export interface BudgetFormSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: BudgetFormValues | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
}

export interface BudgetSettingsProps {
  /** `plugins.bundle.config` 只派发 `page`；保留字段以符合槽位契约。 */
  view?: 'summary' | 'page'
  /** 由注册时的 inject 注入（插件入口里 `configForms.get('cost')`）。 */
  budgetForm: BudgetFormLike
}

const DEFAULT_ENABLED = false
const DEFAULT_PERTURN = 1

// ---- 与仓库配置表单一致的样式 token（带兜底） ----
const TOKENS = {
  descColor: 'var(--dsw-alias-label-secondary, #8a8f98)',
  danger: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-danger, #e5484d))',
  warning: 'var(--dsw-alias-state-warn-label, var(--dsw-alias-warning, #e8a33d))',
} as const

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 2,
}

/** 从表单段读出资额（缺省取 schema 默认值）。 */
function budgetOf(input: unknown): { enabled: boolean; perTurn: number } {
  const root = typeof input === 'object' && input !== null ? input as BudgetFormValues : undefined
  const budget = root?.budget
  return {
    enabled: budget?.enabled ?? DEFAULT_ENABLED,
    perTurn: typeof budget?.perTurn === 'number' ? budget.perTurn : DEFAULT_PERTURN,
  }
}

/** 序列化 resolved 值，用于判断快照是否被外部改动。 */
function resolvedKey(section: { enabled: boolean; perTurn: number }): string {
  return `${section.enabled}|${section.perTurn}`
}

/** 摘要行：当前状态。 */
function summaryText(enabled: boolean, perTurn: number): string {
  return enabled ? `已启用 · 每轮 ¥${perTurn.toFixed(2)}` : '未启用'
}

/** 本插件在 Plugins 页的每轮限额表单。 */
export function BudgetSettingsPage({ view, budgetForm }: BudgetSettingsProps) {
  // useSyncExternalStore 需要稳定的订阅函数；getSnapshot/subscribe 是类方法
  // （内部访问 this.store），必须用闭包包装保留 this，不能传裸引用。
  const subscribe = (listener: () => void): (() => void) => budgetForm.subscribe(listener)
  const getSnapshot = (): BudgetFormSnapshot => budgetForm.getSnapshot()
  // 第三个参数给 SSR/测试提供同一份快照；Web 端实际走客户端渲染。
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const value = budgetOf(snapshot.value)
  const base = budgetOf(snapshot.base)
  const writable = snapshot.writable

  const [draftEnabled, setDraftEnabled] = useState(value.enabled)
  const [draftText, setDraftText] = useState(String(value.perTurn))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastResolved = useRef(resolvedKey(value))

  // 外部改动（其它入口 / 手动编辑 cordis.patch.yml）且本地草稿未被用户改动时，
  // 跟随最新 resolved 值。
  useEffect(() => {
    const key = resolvedKey(value)
    if (key === lastResolved.current) return
    lastResolved.current = key
    setDraftEnabled(value.enabled)
    setDraftText(String(value.perTurn))
  }, [value.enabled, value.perTurn])

  if (view === 'summary') return null
  if (snapshot.status === 'unavailable') return null
  if (snapshot.status === 'loading') {
    return <p style={{ margin: 0, color: TOKENS.descColor, fontSize: 13 }}>限额设置加载中…</p>
  }

  const draftPerTurn = Number(draftText)
  const draftValid = Number.isFinite(draftPerTurn) && draftPerTurn >= 0
  const dirty = draftEnabled !== value.enabled
    || (!draftValid || draftPerTurn !== value.perTurn)

  const commit = async (enabled: boolean, perTurn: number): Promise<void> => {
    if (!draftValid) return
    setSaving(true)
    setError(null)
    try {
      // user 层只在"与组合层不同"时写入；相同则 unset 回落到 composition。
      const ops: BudgetOp[] = []
      if (enabled === base.enabled) ops.push({ op: 'unset', path: ['budget', 'enabled'] })
      else ops.push({ op: 'set', path: ['budget', 'enabled'], value: enabled })
      if (perTurn === base.perTurn) ops.push({ op: 'unset', path: ['budget', 'perTurn'] })
      else ops.push({ op: 'set', path: ['budget', 'perTurn'], value: perTurn })
      const accepted = await budgetForm.mutate(ops, snapshot.revision)
      if (!accepted) setError('宿主拒绝了本次保存（settings 可能已被其它窗口修改），请稍后重试。')
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
      const accepted = await budgetForm.mutate([
        { op: 'unset', path: ['budget', 'enabled'] },
        { op: 'unset', path: ['budget', 'perTurn'] },
      ], snapshot.revision)
      if (!accepted) {
        setError('宿主拒绝了本次恢复（settings 可能已被其它窗口修改），请稍后重试。')
        return
      }
      setDraftEnabled(base.enabled)
      setDraftText(String(base.perTurn))
    } catch (cause) {
      setError(`恢复失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: '20px' }}>
      <div style={rowStyle}>
        <Switch
          checked={draftEnabled}
          label="启用每轮消费限额"
          disabled={!writable || saving}
          onChange={next => { setDraftEnabled(next); setError(null) }}
        />
        <span>启用每轮消费限额</span>
        <span style={{ color: TOKENS.descColor }}>
          {summaryText(value.enabled, value.perTurn)}
          {dirty ? <span style={{ color: TOKENS.warning, marginLeft: 6 }}>未保存</span> : null}
        </span>
      </div>
      <label style={rowStyle}>
        每轮限额（元）
        <Input
          type="number"
          min={0}
          step={0.1}
          value={draftText}
          disabled={!writable || saving}
          onChange={event => { setDraftText(event.target.value); setError(null) }}
          style={{ width: 110 }}
        />
        {!draftValid && <span style={{ color: TOKENS.danger }}>请输入 ≥0 的金额</span>}
      </label>
      <div style={{ fontSize: 12, lineHeight: '18px', color: TOKENS.descColor }}>
        超限行为：仅提示。agent 运行中会在聊天区下方显示“本轮 x / 限额 y”（超限变红）；
        每轮结束后“本轮总消费”芯片标红并注明超限。保存即写入当前 profile 的
        cordis.patch.yml，无需重启。
      </div>
      {error !== null && <div style={{ color: TOKENS.danger }}>{error}</div>}
      <div style={footerStyle}>
        <Button
          variant="outline"
          size="sm"
          disabled={!writable || saving}
          onClick={() => void onReset()}
        >
          恢复组合层默认
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!writable || saving || !dirty || !draftValid}
          onClick={() => void commit(draftEnabled, draftPerTurn)}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
