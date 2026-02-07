# Local Install (FKPolyTools)

## 目標

- 後端（Fastify / TS）：`FKPolyTools_Repo/api_src`
- 前端（Vite / React）：`FKPolyTools_Repo/web_front_src`
- 預設 Port：API = 3001、Web = 5173

## 後端：api_src

```bash
cd FKPolyTools_Repo/api_src
cp .env.example .env
npm ci
npm run dev
```

如需要交易（下單/平倉/auto），必須提供 `POLY_PRIVKEY`（0x 開頭私鑰）。

## 前端：web_front_src

```bash
cd FKPolyTools_Repo/web_front_src
cp .env.example .env
npm ci
npm run dev
```

## 常見痛點（一定要避）

### 1) Port/WS 不一致（WS OFF、Candidates 唔更新）

- API 預設係 `API_PORT=3001`
- 前端 proxy 會用 `VITE_API_PORT`（預設亦係 3001）
- 如果你改過 API port，記得同時改前端 `.env` 入面嘅 `VITE_API_PORT`

### 2) API/Trading 授權狀態卡住

- 交易需要 `POLY_PRIVKEY`（API Key/UUID 唔足夠用嚟簽交易）
- 設定私鑰後，Trading client 初始化失敗會自動重試（有 backoff），UI 會顯示 `Key/Trading/Creds/InitError`

## 驗收

- 前端：打開 `http://localhost:5173`
- 後端：

```bash
curl -sS http://localhost:3001/api/group-arb/setup/status | head
curl -sS http://localhost:3001/api/group-arb/cryptoall/status | head
curl -sS http://localhost:3001/api/group-arb/cryptoall2/status | head
```

## CryptoAll vs CryptoAll2（獨立運作）

- 兩者策略邏輯對齊，但 Config/State 係分開，方便做「進取 vs 保守」對照
- 預設落盤檔案（可用 env 覆蓋）：
  - CryptoAll：`crypto_all_v2.json`
  - CryptoAll2：`crypto_all_2.json`
