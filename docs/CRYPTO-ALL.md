# Crypto All

Crypto All 是獨立策略 namespace，不影響 crypto-15m。

## 交易規則（預設）

    只在到期前少於 180 秒才下注
    只買 best ask >= 0.90（90c）
    deltaAbs >= minDelta（BTC/ETH/SOL/XRP 各自閾值）

deltaAbs 定義：

    deltaAbs = abs(currentSpot - candleOpen)

其中 candleOpen 由 Binance 以 endDateIso - timeframeSec 計算並取該分鐘 Kline open。

## API（雲端）

狀態：

    curl -sS http://56.68.6.71/api/group-arb/cryptoall/status | head

候選：

    curl -sS http://56.68.6.71/api/group-arb/cryptoall/candidates | head

帶參數（symbols/timeframes 逗號分隔）：

    curl -sS http://56.68.6.71/api/group-arb/cryptoall/candidates?symbols=BTC,ETH,SOL,XRP&timeframes=15m,1h,4h,1d&minProb=0.9&expiresWithinSec=180&limit=40 | head

delta 閾值：

    curl -sS http://56.68.6.71/api/group-arb/cryptoall/delta-thresholds | head

啟動/停止：

    curl -sS -X POST http://56.68.6.71/api/group-arb/cryptoall/auto/start -H content-type:application/json -d "{\"amountUsd\":1,\"minProb\":0.9,\"expiresWithinSec\":180,\"pollMs\":2000,\"symbols\":[\"BTC\",\"ETH\",\"SOL\",\"XRP\"],\"timeframes\":[\"15m\",\"1h\"]}"
    curl -sS -X POST http://56.68.6.71/api/group-arb/cryptoall/auto/stop | head

重置 active 狀態（防重複下單用）：

    curl -sS -X POST http://56.68.6.71/api/group-arb/cryptoall/active/reset | head

## UI

    http://56.68.6.71/crypto-all

