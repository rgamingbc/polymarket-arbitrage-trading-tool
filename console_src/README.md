# 控制台客户端

Polymarket 控制台工具，基于 Commander.js 构建。

## 快速开始

```bash
# 安装依赖
pnpm install

# 运行命令
pnpm tsx src/index.ts <command>

# 或者使用别名
pnpm dev <command>
```

## 命令

### 市场命令

```bash
# 列出热门市场
pnpm tsx src/index.ts markets list
pnpm tsx src/index.ts markets list --limit 20

# 查看市场详情
pnpm tsx src/index.ts markets info <conditionId>

# 查看订单簿
pnpm tsx src/index.ts markets orderbook <conditionId>
```

### 套利命令

```bash
# 扫描套利机会
pnpm tsx src/index.ts arb scan
pnpm tsx src/index.ts arb scan --limit 100 --min-profit 0.5

# 检测特定市场
pnpm tsx src/index.ts arb check <conditionId>
```

### 钱包命令

```bash
# 查看排行榜
pnpm tsx src/index.ts wallet leaderboard

# 查看钱包画像
pnpm tsx src/index.ts wallet profile <address>

# 查看持仓
pnpm tsx src/index.ts wallet positions <address>
```

### 监控命令

```bash
# 监控单个市场
pnpm tsx src/index.ts monitor market <conditionId>
pnpm tsx src/index.ts monitor market <conditionId> --interval 3

# 持续扫描套利
pnpm tsx src/index.ts monitor scan
pnpm tsx src/index.ts monitor scan --interval 10 --min-profit 0.5
```

## 快捷命令示例

```bash
# 在根目录创建快捷脚本后可以这样使用：
poly markets list
poly arb scan
poly wallet leaderboard
poly monitor scan
```
