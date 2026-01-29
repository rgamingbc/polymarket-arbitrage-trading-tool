## 先给你“诊断报告”（基于你截图 + 现有实现）

### A) 1/27 已经过了，为什么还会显示 In Review / 还能有 Open？
- 天气市场常见流程是：日期到了以后进入 **In Review**，等待数据确认/审核后才结算。
- 你截图顶部的提示也写了：交易与数据（trades/prices/balance/positions）可能因为 Polygon 问题而延迟更新。
- 所以“日期过去”不代表“市场立刻结算 & 所有订单立刻消失”。

### B) 你看到“只剩一腿（No 33c / 5 shares）且亏 50%”代表什么？
- 这代表 **NO 那腿确实成交了（filled）**，你现在是真实持仓（不是单纯挂单）。
- 另一腿（YES）通常有 4 种可能：
  1) 当时 YES 下单失败（没有 orderId）→ 没有形成双腿
  2) YES 下单成功但没成交（还在 open orders）
  3) YES 被你在官网手动取消（canceled）
  4) YES 也成交了，但你没在页面里看到

### C) 为什么我们的系统“显示 Open / 2 Open”，但官网你找不到？
- 目前 UI 的 **“2 Open”是下单当刻抓到 openOrdersCount 的快照**，它不会自动持续同步。
- 之后如果你在官网取消、市场进入 in review、订单撮合成交等，UI 没刷新状态就会出现错觉：系统说 Open，官网说没有。

### D) 为什么系统没有自动帮你 cut loss？（最关键原因，基本可以锁定）
目前代码里有两处会导致“该止损但没动作 / 动作了但没卖掉”：

1) **监控注册门槛太高**
- 只有当 “YES 和 NO 都成功创建并拿到 orderId” 时，才会把这笔交易加入 monitoredPositions。
- 如果当时只成功了一腿（例如 NO 成功，YES 失败），那这笔最危险的 one‑leg 情况就可能根本没被监控。

2) **退出卖出方式不够可靠**
- 风控触发后需要用“立即成交/尽快退出”的方式卖出。
- 按官方定义，市场型 FOK/FAK 是：
  - 买：按 dollars
  - 卖：按 shares
- 我们需要确保卖出时走正确的 market-order 路径（FAK），否则可能变成“挂了一个卖单但没成交”，你就会继续持有亏损仓位。

结论：你现在看到的现象，非常符合“只成交一腿 + 监控/退出没正确覆盖”的情况。

---

## 你要我“先检查订单有没有真的成功”的做法（我会做，且给你完整报告）
我会以你提供的市场链接为目标，做一个明确的对账：
- 从我们的 Global Order History 找出那一笔 semi trade 的 **orderId（YES/NO 各一）**
- 逐一查询 CLOB 的订单状态：LIVE / CANCELED / FILLED + filledSize
- 给你一份报告：
  - 哪一腿在什么时候成交/取消
  - 是否存在 external cancel（你在官网取消）
  - 如果只剩一腿，为什么风控没有退出（是没注册监控，还是退出订单没成交）

---

## 你要求的“每秒刷新”
- 我同意：**每秒刷新更好**，但要做“轻量版”，避免压力：
  - 前端每秒刷新只拉“你最近 N 条 history + open orders”
  - 每条订单的 status 查询做节流：只对最近/活跃的订单查，不对全部历史查
  - 后端加 cache（例如 500ms~1s）避免重复打 CLOB

---

## 我将实现的修复与增强（按优先级）
### 1) 订单状态同步（秒级刷新 + 详细字段）
- History 行显示：
  - YES/NO 的 orderId
  - 最新 status（LIVE/CANCELED/FILLED）与 filledSize
  - 时间显示：Local + UTC + ago
- 增加 Refresh Status（并可启用自动 1s 刷新）
- 如果检测到 canceled 但不是系统触发，标记：Canceled (external)

### 2) 修复 one‑leg 监控覆盖
- 改成：**只要任意一腿成功（有 orderId）就注册监控**
- one‑leg timeout 到时，按 settings 决定：
  - UNWIND_EXIT（默认更安全）：取消另一腿 + 卖掉已成交腿
  - HEDGE_COMPLETE：强制补齐另一腿（会加 maxSpread/maxSlippage 保护）

### 3) 修复“止损/退出”下单方式（确保能卖掉）
- 卖出使用真正的 market-order FAK（按 shares），必要时 fallback 到贴 bestBid 的可成交限价。

### 4) Polymarket 页面定位
- 在每条 history/open order 提供链接：
  - 直达该 market 的页面
  - 直达 Portfolio 页面

---

## 验证与交付
- 我会用你这条 NYC 市场作为回归：
  - 系统能明确显示：YES/NO 各自状态
  - 如果只剩一腿，监控能识别并按规则自动退出（或至少给出可解释的“为什么没退出”的状态原因）

你确认后，我会先做（1）状态同步与报告输出（最快解决“到底有没有下单、哪一腿还活着”），然后做（2）（3）把 one‑leg 风控真正修到可用。