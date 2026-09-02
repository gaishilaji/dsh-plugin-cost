// 冒烟测试：
//   1. 成本计算纯函数（isPeakHour / computeCost）—— 与官网刊例价核对
//   2. 宿主模块加载契约（name / inject / Config / apply）
//   3. 浏览器 bundle 的 __ModuleLoader__ 握手格式与导出
// 运行：pnpm smoke（或 pnpm test = build + smoke）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ---- 1. 成本计算 -----------------------------------------------------------
const { isPeakHour, computeCost, DEFAULT_PRICES, makeProjection } = await import(join(root, 'lib/index.js'))

const bj = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h - 8, mi) // 把北京时间转成 epoch
const assert = (cond, msg) => { if (!cond) throw new Error(`断言失败: ${msg}`) }

// 高峰：周一 10:00（北京时间）应命中；周日与中午 13:00 不命中。
assert(isPeakHour(bj(2026, 8, 31, 10, 0)) === true, '周一 10:00 应属高峰')
assert(isPeakHour(bj(2026, 8, 30, 10, 0)) === false, '周日 10:00 应属空闲')
assert(isPeakHour(bj(2026, 8, 31, 13, 0)) === false, '周一 13:00 应属空闲')
assert(isPeakHour(bj(2026, 8, 31, 16, 0)) === true, '周一 16:00 应属高峰')

// 官网核对（deepseek-v4-flash 高峰价）：100 万未命中输入 + 100 万输出 = 3 + 9 = 12 元
const flash = DEFAULT_PRICES['deepseek-v4-flash']
assert(flash.cacheMiss === 3.0 && flash.output === 9.0 && flash.cacheHit === 0.10, 'flash 默认价格表')

const peak = computeCost(1_000_000, 0, 1_000_000, flash, true)
assert(Math.abs(peak.cost - 12.0) < 1e-9, `高峰 1M in + 1M out 应为 ¥12，实际 ${peak.cost}`)
const off = computeCost(1_000_000, 0, 1_000_000, flash, false)
assert(Math.abs(off.cost - 6.0) < 1e-9, `空闲应为 ¥6（半价），实际 ${off.cost}`)

// 缓存命中输入按命中价：100 万命中输入（高峰）= 0.1 元
const hit = computeCost(0, 1_000_000, 0, flash, true)
assert(Math.abs(hit.cost - 0.1) < 1e-9, `1M 命中输入应为 ¥0.1，实际 ${hit.cost}`)

// 真实量级核对：输入 146,373 + 输出 114（用户此前会话的真实用量）
const real = computeCost(146_373, 0, 114, flash, false)
assert(real.cost > 0.2 && real.cost < 0.5, `真实会话费用量级应在 ¥0.2~0.5，实际 ${real.cost.toFixed(4)}`)

console.log('✅ 成本计算: 峰谷判断与官网单价核对通过')
console.log('   例：1M 未命中输入 + 1M 输出 高峰 ¥12.00 / 空闲 ¥6.00')

// ---- 1b. 投影折叠（makeProjection.apply 的真实事件流） ----------------------
// 构造两条 assistant/message（peak 与 off-peak 各一），验证逐条费用与累计。
const peakAt = Date.UTC(2026, 7, 31, 2, 0) // 2026-08-31 周一 10:00 北京时间（UTC 02:00）
const offAt = Date.UTC(2026, 8, 1, 5, 0) // 2026-09-01 周二 13:00 北京时间（UTC 05:00）
const msg = (seq, time, id, model, usage) => ({
  type: 'assistant/message',
  seq,
  time,
  data: {
    turn: 1,
    step: seq,
    message: { id, source: { model } },
    usage,
  },
})
const projection = makeProjection({
  prices: DEFAULT_PRICES,
  peakMode: 'auto',
  defaultModel: 'deepseek-v4-flash',
})
let state = projection.init()
// 高峰 10:00：100k 未命中输入 + 1k 输出（flash）→ (0.1M×3 + 0.001M×9) × 1 = 0.309
state = projection.apply(state, msg(1, peakAt, 'm1', 'deepseek-v4-flash', { inputTokens: 100000, outputTokens: 1000 }))
// 空闲 13:00：500k 命中输入（flash）→ (0.5M×0.10) × 0.5 = 0.025
state = projection.apply(state, msg(2, offAt, 'm2', 'deepseek-v4-flash', { inputTokens: 0, cacheReadTokens: 500000, outputTokens: 0 }))
assert(Math.abs(state.messages.m1.cost - 0.309) < 1e-9, `m1 费用应为 0.309，实际 ${state.messages.m1.cost}`)
assert(Math.abs(state.messages.m2.cost - 0.025) < 1e-9, `m2 费用应为 0.025，实际 ${state.messages.m2.cost}`)
assert(Math.abs(state.totals.cost - 0.334) < 1e-9, `累计应为 0.334，实际 ${state.totals.cost}`)
assert(state.totals.input === 100000 && state.totals.cacheRead === 500000 && state.totals.output === 1000, 'totals 桶计数')
// 幂等：同一条消息再次出现不重复计费
const again = projection.apply(state, msg(1, peakAt, 'm1', 'deepseek-v4-flash', { inputTokens: 100000, outputTokens: 1000 }))
assert(again.totals.cost === state.totals.cost, '重复消息不应重复计费')
console.log('✅ 投影折叠: 峰谷计费、逐条明细、累计与幂等性通过')

// ---- 2. 宿主模块加载契约 ---------------------------------------------------
const main = await import(join(root, 'lib/index.js'))
for (const key of ['name', 'inject', 'Config', 'apply']) {
  if (main[key] === undefined) throw new Error(`lib/index.js 缺少导出 ${key}`)
}
assert(main.inject.includes('sessionProjections'), 'inject 应包含 sessionProjections')
console.log('✅ lib/index.js:', JSON.stringify({ name: main.name, inject: main.inject }))

// ---- 3. 浏览器 bundle 握手 -------------------------------------------------
const clientPath = join(root, 'lib/client.js')
const code = readFileSync(clientPath, 'utf8')
let captured = null
globalThis.window = { __ModuleLoader__: { load: (o) => { captured = o } } }
eval(code)
assert(captured !== null, 'lib/client.js 未调用 __ModuleLoader__.load')
assert(captured.id === 'dsh-plugin-cost', `bundle id 错误: ${captured.id}`)
const reactStub = { memo: (fn) => fn, createElement: (..._a) => ({}), useMemo: (fn) => fn(), Fragment: Symbol('f') }
const jsxRuntimeStub = { jsx: () => ({}), jsxs: () => ({}), Fragment: Symbol('f') }
const externals = new Set()
const exported = captured.factory((spec) => {
  externals.add(spec)
  if (spec === 'react') return reactStub
  if (spec === 'react/jsx-runtime') return jsxRuntimeStub
  return {}
})
assert(exported.inject.includes('slots'), 'client inject 应包含 "slots"')
assert(typeof exported.apply === 'function', 'client 缺少 apply')
assert([...externals].every((s) => ['react', 'react/jsx-runtime'].includes(s)), `意外的 external: ${[...externals]}`)
console.log('✅ lib/client.js: id / inject / apply 正确，externals =', [...externals].join(', '))

console.log('✅ 冒烟测试全部通过')
