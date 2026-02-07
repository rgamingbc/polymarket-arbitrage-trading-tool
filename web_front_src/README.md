# Web 前端

Polymarket Web 仪表盘，基于 React + Vite + Ant Design 构建。

## 快速开始

```bash
# 安装依赖（推荐：可复现）
npm ci

# 开发模式
VITE_API_PORT=3001 npm run dev

# 构建
npm run build

# 预览构建
npm run preview
```

## 启动说明

**注意：** 前端通过 Vite proxy 转发 `/api` 到后端，默认后端端口是 `3001`（可用 `VITE_API_PORT` 覆盖）。

```bash
# 1. 先启动 API 服务
cd ../api_src
npm ci
API_PORT=3001 npm run dev

# 2. 再启动前端
cd ../web_front_src
npm ci
VITE_API_PORT=3001 npm run dev
```

访问 http://localhost:5173

## 页面

| 页面 | 路径 | 功能 |
|------|------|------|
| 仪表盘 | `/dashboard` | 热门市场、套利机会概览 |
| 市场 | `/markets` | 市场列表、搜索、详情 |
| 套利 | `/arbitrage` | 套利扫描、机会列表 |
| 钱包 | `/wallets` | 交易员排行榜 |

## 技术栈

- **React 18** - UI 框架
- **Vite** - 构建工具
- **Ant Design 5** - UI 组件库
- **React Router** - 路由
- **Axios** - HTTP 客户端
- **TradingView Lightweight Charts** - K 线图（待实现）

## 待实现功能

- [ ] K 线图表组件
- [ ] WebSocket 实时数据
- [ ] 钱包详情页面
- [ ] 市场详情 + 订单簿可视化
