# Poly-SDK 示例

全面演示 Polymarket SDK 功能的示例集合。

## 运行示例

```bash
# 从 poly-sdk 目录
pnpm tsx examples/01-basic-usage.ts

# 或使用 pnpm 脚本
pnpm example:basic       # 01-basic-usage.ts
pnpm example:smart-money # 02-smart-money.ts
```

---

## 示例概览

| # | 文件 | 描述 | 需要授权 |
|---|------|------|----------|
| 01 | `basic-usage.ts` | 热门市场、订单簿数据 | 否 |
| 02 | `smart-money.ts` | 聪明钱钱包分析 | 否 |
| 03 | `market-analysis.ts` | 市场搜索和分析 | 否 |
| 04 | `kline-aggregation.ts` | 价格历史和K线数据 | 否 |
| 05 | `follow-wallet-strategy.ts` | 跟单交易模拟 | 否 |
| 06 | `services-demo.ts` | WalletService & MarketService | 否 |
| 07 | `realtime-websocket.ts` | 实时订单簿更新 | 否 |
| 08 | `trading-orders.ts` | 下单和订单管理 | 是 |
| 09 | `rewards-tracking.ts` | 流动性奖励追踪 | 是 |
| 10 | `ctf-operations.ts` | 拆分/合并/赎回代币 | 是 |
| 11 | `live-arbitrage-scan.ts` | 扫描市场寻找套利 | 否 |
| 12 | `trending-arb-monitor.ts` | 实时套利监控 | 否 |
| 13 | `arbitrage-service.ts` | 完整套利工作流 | 是 |

---

## 示例详情

### 01 - 基础用法

开始使用 SDK。获取热门市场和订单簿数据。

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';
const sdk = new PolymarketSDK();
const trending = await sdk.gammaApi.getTrendingMarkets(5);
```

### 02 - 聪明钱分析

分析钱包交易表现，识别盈利交易员。

- 获取钱包持仓和活动
- 计算盈亏和胜率
- 识别高绩效钱包

### 03 - 市场分析

按各种条件搜索和分析市场。

- 关键词搜索
- 按交易量、流动性过滤
- 分析市场价差

### 04 - K线聚合

获取价格历史用于图表绘制。

- 多时间框架蜡烛图（1分钟、5分钟、1小时、1天）
- OHLCV 数据
- 双代币 YES/NO 价格追踪

### 05 - 跟单钱包策略

基于聪明钱信号模拟跟单交易。

- 监控钱包活动
- 生成交易信号
- 回测策略表现

### 06 - 服务层演示

高级服务抽象。

- `WalletService` - 钱包分析助手
- `MarketService` - 市场数据聚合

### 07 - 实时 WebSocket

实时订单簿流。

- 连接 Polymarket WebSocket
- 实时价格更新
- 订单簿变化事件

### 08 - 交易订单

下单和管理订单（需要私钥）。

```bash
POLY_PRIVKEY=0x... pnpm tsx examples/08-trading-orders.ts
```

- 创建限价/市价单
- 取消订单
- 检查订单状态

### 09 - 奖励追踪

追踪流动性提供者奖励。

- 按市场获得的奖励
- 订单评分指标
- 奖励率分析

### 10 - CTF 操作

链上代币操作（需要私钥 + USDC.e）。

```bash
POLY_PRIVKEY=0x... pnpm tsx examples/10-ctf-operations.ts
```

**重要:** 使用 USDC.e（非原生 USDC）：
| 代币 | 地址 | CTF 兼容 |
|------|------|----------|
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | 是 |
| 原生 USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | 否 |

操作：
- **拆分**: USDC.e → YES + NO 代币
- **合并**: YES + NO → USDC.e（套利获利）
- **赎回**: 获胜代币 → USDC.e

### 11 - 实时套利扫描

扫描市场寻找套利机会（只读）。

- 获取活跃市场
- 计算有效价格
- 检测多头/空头套利机会

### 12 - 热门市场套利监控

持续监控热门市场。

- 实时订单簿分析
- 正确的有效价格计算
- 可配置扫描间隔

### 13 - 套利服务

完整的套利工作流（ArbitrageService）。

- 市场扫描
- 实时监控
- 自动执行
- 仓位清理

---

## 套利概念

Polymarket 订单簿具有镜像属性：
- **买 YES @ P = 卖 NO @ (1-P)**

正确的有效价格：
```
effectiveBuyYes = min(YES.ask, 1 - NO.bid)
effectiveBuyNo = min(NO.ask, 1 - YES.bid)
effectiveSellYes = max(YES.bid, 1 - NO.ask)
effectiveSellNo = max(NO.bid, 1 - YES.ask)
```

| 套利类型 | 条件 | 操作 |
|----------|------|------|
| 多头 | `effectiveBuyYes + effectiveBuyNo < 1` | 买入两者，合并得 $1 |
| 空头 | `effectiveSellYes + effectiveSellNo > 1` | 拆分 $1，卖出两者 |

---

## 环境变量

| 变量 | 描述 | 用于 |
|------|------|------|
| `POLY_PRIVKEY` | 交易私钥 | 08, 09, 10, 13 |
| `SCAN_INTERVAL_MS` | 套利扫描间隔（毫秒） | 12 |
| `MIN_PROFIT_THRESHOLD` | 最小套利利润 % | 11, 12 |
