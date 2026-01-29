## 先回答：oneLegTimeoutMinutes 是什么？有什么“限制”？

### 它的意义（你可以当成“允许单腿曝险的最长时间”）
- 当你下双腿订单后，最危险的情况是：**只成交一腿**（你变成单边仓位）。
- `oneLegTimeoutMinutes` 就是：如果只成交一腿持续超过这个时间，系统会执行 timeout 逻辑（例如取消未成交腿、或进入退出/止损流程）。

### 它的 trade-off（为什么你会感觉需要 on/off）
- 太短：可能还来不及补齐另一腿就被取消，导致你更常出现单腿/取消。
- 太长：单腿曝险时间变长，遇到行情快速反向会亏得更快。

### 目前的“限制”该怎么设计才合理
- 我会把它做成可控的、显式的开关与范围校验：
  - 建议范围：**1–120 分钟**（防止误填 0 或 9999 这种极端值）
  - 默认值：**10 分钟**（对大多数薄盘口更保守）
  - 并且提供 **Enable/Disable**：关掉就完全不触发 timeout 相关的自动取消/动作。

## 你提出的改动（我已纳入，且按你要求 Hedge-Complete 默认 OFF）

### A) Timeout 逻辑做成 Setting box：有开关 + 可调分钟
新增两个设置：
- `Enable One-Leg Timeout`（默认 ON）
- `One-Leg Timeout Minutes`（默认 10，可调 1–120）

行为：
- OFF：系统不会因为 timeout 去取消任何一腿（避免你担心的“unreasonably cancel 1 leg”）。
- ON：到时才执行（取消未成交腿 / 或按策略退出）。

### B) “Auto-cancel 未成交腿”单独开关（更细颗粒）
新增：
- `Auto-cancel unfilled leg on timeout`（默认 ON，但你可关）

这样即使 timeout ON，你也可以选择：
- 只提醒/只记录，不自动取消（你手动决定）

### C) Hedge-Complete 作为 A/B 测试逻辑开关（默认 OFF）
新增：
- `Enable Hedge-Complete (A/B)`：默认 **OFF**
- OFF 时：系统只允许 UNWIND_EXIT（更安全）或仅取消未成交腿
- ON 时：才允许启用 `HEDGE_COMPLETE`，并强制配合：`maxSpread/maxSlippage` 保护

### D) 增加 “Exit Now” 按钮（Dashboard + Monitor）
- 一键：取消相关挂单 + 以 market FAK（按 shares）尝试卖出单腿
- 写入 history：`manual_exit`，方便你复盘

## 实现计划（你确认后我就开始改代码）

### 1) 后端（风控状态机）
- 扩展 settings：
  - `enableOneLegTimeout: boolean`
  - `oneLegTimeoutMinutes: number (1–120)`
  - `autoCancelUnfilledOnTimeout: boolean`
  - `enableHedgeComplete: boolean (default false)`
- 逻辑约束：
  - enableHedgeComplete=false ⇒ 强制 oneLegTimeoutAction=UNWIND_EXIT
  - enableOneLegTimeout=false ⇒ 不运行 timeout cancel/timeout exit
- 新增：`POST /api/group-arb/exit-now`

### 2) 前端（Settings box + 控制）
- Settings modal 加：
  - Enable One-Leg Timeout（开关）
  - One-Leg Timeout Minutes（输入框）
  - Auto-cancel unfilled leg on timeout（开关）
  - Enable Hedge-Complete (A/B)（开关，默认 OFF）
- 传参到 `/execute-shares`

### 3) 验证方式（你下一次下单我们一起录制）
- timeout OFF：确认不会出现系统自动 cancel
- timeout ON + autoCancel ON：确认到点只取消未成交腿，并在 history 标注原因
- Exit Now：确认能强制退出单腿并记录

你确认后我会按上面顺序落地，并给你一份“本次下单的两腿 orderId、最终状态、cancel 由谁触发”的对账报告。