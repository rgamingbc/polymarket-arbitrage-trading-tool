## 先回答你的問題（含案例）
### one‑leg timeout 兩種模式是什麼？
當你按「Buy All」後，理想狀況是 YES/NO 兩腿都成交（你拿到一組“set”）。但常見風險是：
- 只成交一腿（one‑leg filled），另一腿長時間沒成交。
- 這時你其實變成單邊曝險（方向性倉位），不是套利。

因此 timeout 到時要選：

**A) Hedge/Complete（強制補另一腿）**
- 做法：到 timeout 還沒成交的那腿，改成更積極的價格（甚至用 FAK/市場可成交價）把它補齊。
- 優點：快速回到「兩腿都有」的中性套利結構。
- 缺點：在流動性差/價差大時，你可能被迫用很差的價格補齊，等於付出很大的滑點。

**B) Unwind/Exit（止損退出已成交的那腿）**
- 做法：取消另一腿，並把已成交那腿用市場可成交的方式（FAK/貼近 best bid）賣掉，立刻回到無倉位。
- 優點：最小化方向性風險暴露時間。
- 缺點：你通常會付出一次買進/賣出價差成本（spread cost），等於小虧退出。

### 三個很直觀的 Case Study
**Case 1：流動性好、價差薄（適合 Hedge）**
- YES/NO 都有很深的掛單，spread 1–2c。
- 你成交了 YES 但 NO 沒成交。
- 這時用 Hedge 補 NO 的成本很小（1–2c 的滑點），補齊後你回到中性，後續更接近“套利策略”。

**Case 2：其中一腿很薄、spread 很大（適合 Unwind）**
- NO 的 book 很薄，spread 8–15c。
- 你先成交了 YES，但 NO 完全補不上；若硬補 NO，你等於用很差的價格追進去。
- 這種情況 Unwind 更合理：立刻退出已成交腿，讓損失上限可控。

**Case 3：臨近事件、價格跳動快（偏向 Unwind 或 Hedge 但需“滑點上限”）**
- 接近截止時間或重大消息時，價格可能瞬間跳。
- Hedge 可以，但必須加「最大可接受滑點」：超過就不要補，改 Unwind。

結論：
- 你的需求「更安全」= 必須把這個選項做成 Settings，並且每種模式都要有滑點/價差門檻，否則風險曲線會很不穩。

## 你回報的 UI/功能問題原因（我確認）
1) 你說刷新後看不到自動策略：目前自動交易只是在 **高级策略(Advanced) 页面内部的 Tab**，不是侧边栏菜单项；所以你会觉得“菜单没出现”。
2) 策略名称（TDL）目前没有一个“策略选择框/显示框”，所以你看不到“正在使用哪一套策略”。
3) Global order history 时间与状态：
- 后端写入时间是 ISO UTC；前端用 `toLocaleString()` 显示本地时间，但你看到不一致时，我们应该同时显示 **Local + UTC + 相对时间(ago)**，并明确标注。
- 你在 Polymarket 官网手动取消订单，我们目前 history 里不会自动更新成 CANCELED；需要做“状态同步刷新”。
4) 扫描排序仍把 0.4/99.7 推上去：目前排序主要看 totalCost（套利空间）和 spread，其次才看 ratioScore；极端比例市场会因为 totalCost 接近 100 而被排前面，但它们通常更难成交、风险更大。

## 执行计划（你确认后我就开始改代码）
### 1) 把自動交易变成侧边栏菜单项
- 新增 `/auto-trade` 路由页面（显示：策略列表、启用开关、kill switch）。
- 侧边栏新增菜单：**🤖 自動交易**，从“高级策略”独立出来，避免你找不到。

### 2) 加入“策略选择框 + 策略名称显示 + 策略绩效维度”
- 在 Advanced → Group Arbitrage 顶部加一个 Strategy Select：
  - Strategy I: **TDL (Twin‑Leg Discount Ladder)**
  - 预留 Strategy II/III（先灰掉/占位）。
- 每次下单写入 history：`strategyId`、`strategyName`、`mode(manual/semi/auto)`。
- Dashboard/History 增加按 strategy 过滤与计数（先做基础：次数、成功率、open orders 数）。

### 3) Global Order History 的时间与状态改进
- 时间显示三列：
  - Local Time
  - UTC Time
  - Age（例如 3m ago）
- 每个 leg 显示：orderId、当前状态（LIVE/FILLED/CANCELED/…）、filledSize。
- 增加“Refresh Status”按钮：
  - 后端会根据 orderId 查询最新状态，并回写到 history（或在响应中附带最新状态）。
- 你的“官网手动取消”：
  - 若发现状态变成 CANCELED 且不是我们系统触发 cancel，则标记为 `Canceled (external)`。

### 4) one‑leg timeout 行为做成可选策略（最关键）
- 在 Settings 加一个选项：`oneLegTimeoutAction`：
  - `HEDGE_COMPLETE`（补另一腿）
  - `UNWIND_EXIT`（退出已成交腿）
- 增加保护参数：
  - `maxSlippageCents`（Hedge 时最多允许补单滑点）
  - `maxSpreadCentsForHedge`（spread 超过就不要 hedge）
- 让风控引擎严格按该选项执行。

### 5) 扫描排序改为“更适合套利成交”的优先级
- 增加可配置筛选/偏好：
  - `minRatioScore`（默认例如 0.4，对应约 30/70 以上）
  - 或 `yesPriceRange`（例如 0.30–0.70）
- 排序改为综合评分：
  - 优先：更高的预期利润（更低 totalCost）
  - 其次：更薄 spread
  - 再其次：更高 ratioScore（更接近 50/50）
  - 再其次：更高 liquidity、离截止时间更安全

## 验证方式
- UI：侧边栏出现“🤖 自動交易”，Advanced 页面出现 Strategy Select。
- History：刷新后能看到订单 LIVE/取消/成交状态更新。
- Scanner：不会再让 0.4/99.7 长期霸榜（除非你把 ratio filter 放得很宽）。

你确认后我会按 1→5 顺序实现，并在每步后用页面和 API 实测确认。