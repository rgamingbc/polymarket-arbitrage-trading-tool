# API 后端服务

Polymarket API 后端服务，基于 Fastify 构建。

## 快速开始

```bash
# 安装依赖（推荐：可复现）
npm ci

# 开发模式
API_PORT=3001 npm run dev

# 构建
npm run build

# 生产模式
API_PORT=3001 npm run start
```

## API 端点

### 市场

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/markets/trending` | 获取热门市场 |
| GET | `/api/markets/:conditionId` | 获取市场详情 |
| GET | `/api/markets/:conditionId/orderbook` | 获取订单簿 |
| GET | `/api/markets/:conditionId/klines` | 获取 K 线数据 |

### 套利

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/arbitrage/scan` | 扫描套利机会 |
| GET | `/api/arbitrage/:conditionId` | 检测特定市场套利 |

### 钱包

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/wallets/leaderboard` | 获取排行榜 |
| GET | `/api/wallets/:address/profile` | 获取钱包画像 |
| GET | `/api/wallets/:address/positions` | 获取钱包持仓 |
| GET | `/api/wallets/:address/activity` | 获取钱包活动 |

### WebSocket

| 路径 | 描述 |
|------|------|
| `ws://localhost:3001/ws/market/:conditionId` | 实时市场数据推送 |

## 环境变量

| 变量 | 默认值 | 描述 |
|------|--------|------|
| `API_PORT` | `3001` | API 端口 |
| `API_HOST` | `0.0.0.0` | 监听地址 |
| `CORS_ORIGIN` | `*` | CORS 来源 |
| `POLY_PRIVKEY` | - | Polymarket 私钥（交易用） |

## API 文档

启动服务后访问: http://localhost:3001/docs
