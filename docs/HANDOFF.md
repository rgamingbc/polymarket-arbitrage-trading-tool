# HANDOFF（交接總覽）

## 你要達成的目標

- 15m 幣圈策略（BTC/ETH/SOL）可 24 小時穩定運行：
  - 最後 180 秒才下單
  - 只買 best ask ≥ 0.90（90c）的一面（Up 或 Down 依當時價格）
  - 多標的並發（BTC/ETH/SOL 同時有機會就都下）
  - redeemable=true 時自動 redeem（背景常駐）
- 不浪費 relayer credit：
  - 只在 data-api `redeemable=true` 才會觸發 redeem
  - 手動 /redeem/conditions 預設 redeemable=false 會 skip，除非 `force=true`

## 架構與倉庫定位

### 後端（策略 + redeem）

- 目錄：`FKPolyTools_Repo/api_src`
- 提供 API：`/api/group-arb/*`
- 交易邏輯與風控（90c/180s/並發）都在後端
- 敏感資訊（私鑰、relayer keys）只放在 env / 本機 config，不進 git

### 前端（內建 UI）

- 目錄：`FKPolyTools_Repo/web_front_src`
- 主要頁：
  - `/crypto-15m`：15m 幣圈策略監控與半自動下單
  - `/advanced`：更完整的歷史/執行紀錄

### 可選：獨立 UI repo（你提到的 mobile/front-end-only）

- Repo：`https://github.com/rgamingbc/FKPolyTools_repo`
- 建議定位：純前端（Web/手機版），只對接 `/api/group-arb/*`
- 不要放任何私鑰/relayer key 在前端；前端只做展示、按鈕、狀態、UX

## 必要設定（env / 落盤檔）

### 敏感 env（必備）

- Polymarket 私鑰（後端用）：`config.polymarket.privateKey`（或你現有的方式注入）

### 建議設定 env（持久化落盤路徑）

若不設定，預設寫到系統 tmp；重啟/清 tmp 會丟失設定。建議你在真正長跑機器上指定固定目錄：

- `POLY_RELAYER_CONFIG_PATH` → relayer.json（多 key + activeIndex）
- `POLY_AUTO_REDEEM_CONFIG_PATH` → auto-redeem.json（enabled/maxPerCycle）
- `POLY_ORDER_HISTORY_PATH` → history.json + history.json.bak（操作/交易/赎回歷史）
- `POLY_PNL_SNAPSHOT_PATH` → pnl-snapshots.json（資產快照）

## 24 小時運行（建議配置與監控）

### 建議策略參數

- `minProb = 0.90`
- `expiresWithinSec = 180`
- `pollMs = 2000`
- `amountUsd`：依你風險承受度（例如 1~10）

### 你要觀察的狀態（每 5~10 分鐘看一次）

- Auto trade 狀態：`GET /api/group-arb/crypto15m/status`
  - `enabled=true`
  - `actives` 可能同時有 BTC/ETH/SOL
  - `lastError` 應該為 null
- Auto redeem 狀態：`GET /api/group-arb/auto-redeem/status`
  - `config.enabled=true`
  - `inFlight.count` 不應永久累積
- Relayer 狀態：`GET /api/group-arb/relayer/status`
  - 若看到 401/invalid authorization，切換 active key（見下）

### 常見故障與處理

- 401 invalid authorization（relayer key 不對/被撤銷）
  - 用 `POST /api/group-arb/relayer/active` 切換 `activeIndex`
- 429 quota exceeded（relayer 單 key 配額用完）
  - 後端會標記 exhausted；你需要確保有多把 key 並輪換
- RPC rate limited / 不穩
  - 需要多個 RPC URL（`POLY_RPC_URLS` 類似配置）與合理重試

## 一鍵操作/維護 API

- 啟動策略：`POST /api/group-arb/crypto15m/auto/start`
- 停止策略：`POST /api/group-arb/crypto15m/auto/stop`
- 半自動單筆下單：`POST /api/group-arb/crypto15m/order`（會檢查 best ask ≥ minPrice）
- 清空 active（排障用）：`POST /api/group-arb/crypto15m/active/reset`
- 手動 redeem：`POST /api/group-arb/redeem-now`
- 針對指定 condition redeem：`POST /api/group-arb/redeem/conditions`（可 `force=true`）

## 給 GPT-5.2 的標準提示詞（全景）

```text
你是 GPT-5.2，請先閱讀並遵循 repo 內文件：
1) FKPolyTools_Repo/docs/backup-reinstall-plan.md
2) FKPolyTools_Repo/docs/arb/15m-crypto-trade.md
3) FKPolyTools_Repo/docs/HANDOFF.md

目標：
- 後端 FKPolyTools_Repo/api_src + 前端 FKPolyTools_Repo/web_front_src 正常啟動
- 15m crypto 策略：最後 180 秒才下單；只買 best ask >= 0.90 的那一面；BTC/ETH/SOL 並發
- auto-redeem 常駐，且只在 redeemable=true 時 redeem
- relayer 多 key 可切換，401/429 需可診斷與處理

請輸出：
- 啟動後可用的 URL 與 API endpoints
- 24 小時運行 checklist + 故障排查手冊
```

## 給 “前端-only（Gemini / 另一位工程師）” 的提示詞

```text
你只負責前端（Web/手機版），不要修改後端策略/交易邏輯。
後端 API 只用 /api/group-arb/*
請做：手機版 UI、自適應、狀態面板、錯誤提示、按鈕防抖、載入狀態。
不要處理私鑰/relayer key；敏感配置全部在後端。
```

## 要我做“備份 + 重裝演練”的提示詞

```text
請你做一次可復現的備份 + 重裝演練（一定要給 checklist）：
1) 列出所有 env（標注敏感/非敏感）
2) 列出所有落盤檔位置與用途（relayer/auto-redeem/history/pnl）
3) 更新 HANDOFF（加入任何新決策/排障方法）
4) 做 smoke test：90c gating、並發下單、auto-redeem 背景運行、relayer key 切換
5) 給前端-only 的最小 prompt
```
