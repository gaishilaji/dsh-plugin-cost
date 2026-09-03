# dsh-plugin-cost —— DeepSeek 对话消费提示插件

## 安装

**方式一：从 npm 安装（推荐）** —— 安装的是带构建产物的包，无需任何构建授权：

```sh
# npm 安装版 dsh：
dsh plugin --profile web add dsh-plugin-cost
# 源码 checkout 形态（在 dsh 仓库根目录）：
pnpm dsh plugin --profile web add dsh-plugin-cost
```

**方式二：从 Git 安装**（开发/尝鲜；安装时 pnpm 会运行包的 `prepare` 从源码构建，见下方授权说明）：

```sh
# npm 安装版 dsh：
dsh plugin --profile web add github:gaishilaji/dsh-plugin-cost
# 源码 checkout 形态（在 dsh 仓库根目录）：
pnpm dsh plugin --profile web add github:gaishilaji/dsh-plugin-cost
```

安装完成后**重启 `dsh web`** 生效

## 简介

每个会话的 token 用量与费用实时展示在 Web UI 里，并且可以设置限额提示：

- **每轮汇总**：每轮消息操作条（与内置的"耗时 / TTFT / tok/s"同排）上显示
  `本轮总消费 ¥0.0987` —— 该轮**全部**模型调用的合计（一轮 agent 执行会产生多条
  assistant 消息：文本回答 + 中间多次纯工具调用步骤，后者没有气泡但仍按 usage 计费）。
  **悬停弹出明细浮层**：
  - **对话费用（本条回复）**：该轮最后那条可见回复自身的费用；
  - **调用明细**：逐条列出该轮每一步：`#步序 时刻 文本/工具名 入·缓存读·出 ¥费用`；
  - **本轮合计**：入/缓存读/出 tokens 与金额，和总账严格对齐；
- **每轮限额（可选，默认关闭）**：在 Web 设置（本插件设置卡）或 `cordis.patch.yml`
  的 `config.budget` 里启用后——
  - agent **运行中**：输入框上方整行区动态显示 `本轮 ¥0.34 / 限额 ¥1.00`
    （**流式估算**：思考/正文/工具参数一边输出一边按字符估算、实时上涨，带 `≈`
    与"（含流式估算）"标记；每步完成即用真实 usage 校正——**最终显示一律是精确值**）；
    **超限变红**并提示"已超本轮限额"；对话结束自动隐藏；（流式因为拿不到token只能是估算值，但是在一轮对话中误差可以忽略不计）
  - 每轮结束后：如果超限额，该轮"本轮总消费"**芯片标红**，hover 浮层内注明已超限额（精确值）；
- **输入框下方读数带**：常驻显示 `总消费 ¥X · 输入 N · 输出 M`（本会话累计，口径不变）。

费用按 DeepSeek 官方刊例价（[《模型 & 价格》](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)）
实时计算，支持**分时定价**：高峰（北京时间周一至周五 9:00–12:00、14:00–18:00）按刊例价，
空闲时段自动半价。

## 计费

dsh 的 usage 字段是 disjoint 计数（`llm-deepseek` adapter：缓存读从输入里剔除）：

```
费用 = 未命中输入 × miss单价 + 命中输入(cacheRead) × hit单价 + 输出 × 输出单价
```

- 目前只支持deepseek模型计费。模型定价来源2026年8月。
- 价格单位为 **元 / 百万 tokens**，配置里存的是**高峰价**，空闲自动 ×0.5；
- 每条消息按其**发生时刻**（会话事件时间）判断峰谷 → 可重放、幂等；
- 默认价格表（2026-08 官网快照，高峰价）：

| 模型 | 输入·缓存命中 | 输入·缓存未命中 | 输出 |
|---|---|---|---|
| deepseek-v4-flash / v4-flash-vision-exp | ¥0.10 | ¥3.00 | ¥9.00 |
| deepseek-v4-pro | ¥0.30 | ¥9.00 | ¥27.00 |

> **价格会变**：官网调价后只需改 `cordis.patch.yml` 里 `config.prices` 的数值（无硬编码），
> 或覆盖任意模型。未知模型仍记录用量、费用按 0（便于你补价目）。

## 项目结构

```
dsh-plugin-cost/
├── package.json          # dsh.bundle + dsh.client；peer/dev 依赖；scripts
├── tsdown.config.ts      # 宿主 ESM 库 + 浏览器 CJS bundle 两段构建
├── cordis.patch.yml      # bundle 配置层（价格表、峰谷、限额在此配置）
├── dev/cordis.yml        # 开发期 --patch overlay（只加载宿主半身）
├── src/
│   ├── index.ts          # 宿主：cost 投影（计费 + turn/step + 当前轮 + 流式估算 + 限额下发/settings 注册）
│   └── client/
│       ├── index.tsx     # 浏览器：input.dock 动态本轮/限额行 + assistant-actions 汇总芯片/浮层 + composer.dock 总消费
│       └── settings-card.tsx  # 浏览器：Plugins → 配置 页的每轮限额设置卡
└── test/smoke.mjs        # 峰谷/单价核对 + 宿主契约 + client 握手验证
```

## 工作原理（dsh 机制速览）

- 宿主侧：从会话事件流按消息 id 折叠费用明细，注册为名为 `cost` 的 **projection**
  （`ctx.sessionProjections.register`）；用 `turn/start`、`turn/end` 维护"当前轮"
  （openTurn）；并把**当前生效的每轮限额**作为 wire 视图附加字段随帧下发；
- 限额是**双份源**：`cordis.patch.yml` 的 `config.budget` 是默认/部署层；Web 设置里
  本插件在 Plugins → 配置 页的设置卡（`settings.plugin.item`，键=`dsh-plugin-cost`）
  通过 `settingsScope` 写 `settings.yaml` 的 user 层覆盖。宿主用
  `installSettingsSection` 注册命名空间——保存后无需重启，下一轮/下一步生效
  （settings 服务缺席的环境自动退化为纯 config）；
- 浏览器侧：`useProjection('cost')` 订阅宿主推送，渲染三处——
  `conversation.input.dock`（运行中本轮/限额动态行）、
  `conversation.chat.assistant-actions`（每轮总消费芯片与 hover 明细）、
  `conversation.composer.dock`（总消费读数带）；
- 宿主侧 `inject: ['sessionProjections']`、浏览器侧 `inject: ['slots']`：Cordis 的"未声明即访问"契约。

## 配置项（cordis.patch.yml / config 块 / Web 设置卡）

| 字段 | 默认 | 说明 |
|---|---|---|
| `prices` | 上表 | `{ [model]: { cacheHit, cacheMiss, output } }`，高峰价（元/百万） |
| `peakMode` | `auto` | `auto` 按北京时间分时；`peak` 恒高峰；`off-peak` 恒空闲 |
| `defaultModel` | `deepseek-v4-flash` | message 读不到模型名时的兜底 |
| `budget.enabled` | `false` | 是否启用每轮消费限额（Web 设置卡可改） |
| `budget.perTurn` | `1` | 每轮消费上限（元，≥0）（Web 设置卡可改） |
| `budget.mode` | `'warn'` | 超限行为：`'warn'` 仅提示（`'ask'` 询问预留，未实现） |

## 已知边界

- 金额为**估算**，与实际账单可能存在舍入/汇率/活动差异，以 DeepSeek 官方账单为准；
- 费用按 `assistant/message` 的 usage 计算：一次请求（step）一条消息；
  同一会话重放（刷新/恢复）由 projection 缓存保证不重复计费；
- 每条消息的费用在消息出现后**即刻**显示（投影帧随事件流推送，可能比消息渲染晚一拍）；
- 运行中的"流式估算"是**近似值**：按已流出的字符数 × 约 3.2 字符/token × 输出单价推算，
  只覆盖输出侧（思考/正文/工具参数），并按 `defaultModel` 计价（流式中模型名未知）；
  每步完成即以真实 usage 校正——**所有最终显示（每轮芯片、浮层、总消费）一律为精确值**。
