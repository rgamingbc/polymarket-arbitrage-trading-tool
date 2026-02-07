# CLOUD-UPDATE-PROMPT (FKPolyTools)

## 目標

- 目的：喺新機 / 新 agent / 雲端更新時，避免重踩本機安裝同策略獨立性陷阱。
- 專案入口：
  - API：`FKPolyTools_Repo/api_src`
  - Web：`FKPolyTools_Repo/web_front_src`

## 必檢（會直接令 UI 壞）

### 1) Port 一致（WS/Proxy）

- API 預設 `API_PORT=3001`
- Web proxy 會用 `VITE_API_PORT`（預設亦係 3001）
- 症狀：如果唔一致，前端會出現 WS 連線錯 / Candidates 唔更新（以前叫「WS: OFF」）

### 2) Trading/Auth 狀態

- 交易/下單需要 `POLY_PRIVKEY`（0x… 私鑰）先可以簽交易
- 純 API Key（UUID）唔足夠
- Dashboard 有 `/group-arb/setup/status` 同 `/group-arb/setup/config` 可以寫入私鑰並熱重啟 scanner
- Trading client 初始化失敗會自動重試（有 backoff），CryptoAll/CryptoAll2 頁面會顯示 `Key/Trading/Creds/InitError`

### 3) 本地完全打唔開（Dashboard/CryptoAll/All2 全部入唔到）

- 首先確認 Web 係真係起咗（Vite）：預設 `http://localhost:5173/`
- 如果 `localhost:5173` 連唔到：
  - 大多數原因係未有起 Web（要喺 `FKPolyTools_Repo/web_front_src` 起）
  - 或者 5173 被佔用，Vite 會自動轉用 5174/5175（以啟動 log 顯示嘅 URL 為準）
- 如果你其實係喺「另一部機/容器/雲端」起 server：
  - `localhost` 只會指向你本機，必然打唔開
  - 建議用 SSH port-forward，或者用 `vite --host 0.0.0.0` 再用 `http://<機器IP>:5173/` 開

## 策略獨立性（CryptoAll vs CryptoAll2）

- 兩者要「策略邏輯對齊」但「Config/State 必須獨立」
- 預設落盤檔案（可用 env 覆蓋）：
  - CryptoAll：`crypto_all_v2.json`
  - CryptoAll2：`crypto_all_2.json`

## 快速驗收

```bash
curl -sS http://localhost:3001/api/group-arb/setup/status | head
curl -sS http://localhost:3001/api/group-arb/cryptoall/status | head
curl -sS http://localhost:3001/api/group-arb/cryptoall2/status | head
```

## 安全提醒

- 唔好將 `.env`、私鑰、relayer keys 入 git
