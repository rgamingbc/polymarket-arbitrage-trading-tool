# 保留最近50場記錄 + 修復 Duplicate 下單 + 修復 No-asks（Crypto15m / CryptoAll / FollowActivity）

## 目標
- **記錄唔可以再清走到 0**：任何「清理」只可以清 50 以外，最少保留最近 50 場。
- **保留第2槍**：買唔夠/買唔到可以再試，但 **唔可以變成重複 exposure**（已成交仲落第 2 張同額單）。
- **修復 No-asks 誤導**：UI 唔再因為 parse bug 而顯示 0.0c / no-asks。

## 1) Duplicate 下單修復（保留第2槍，但只補差額）
### Crypto15m（非 Sweep）
- 保留原本「第 2 次 attempt」概念。
- 新邏輯係：Attempt #1 後會 **短時間 verify**（查 order / open orders）以估算已成交。
- **第2槍只會買剩餘要買嘅 USD（Top-up）**，唔會再落一張一樣 amount。

### CryptoAll（自動模式 20s retry）
- 仍然保留「失敗後 cooldown 再試」機制。
- 但喺 cooldown 到期後 **會先 verify**（查 order / open orders），如果發現其實已落到單/已成交，就會直接標記為已落單，避免再落第 2 張。
- 同時喺 createMarketOrder 返回失敗時亦會做一次短 verify，避免「回應誤判」造成 duplicate。

## 2) No-asks 修復（/books 回應 token_id 解析）
- `CLOB /books` 回傳 book object 通常以 `token_id` 表示 token。
- 之前部份位置只用 `asset_id/assetId` 取 tokenId，會導致書簿更新被跳過 → UI 變成 no-asks / stale。
- 已統一以 `token_id || tokenId || tokenID || asset_id || assetId` 取 tokenId。

## 3) 記錄保留最近 50（FollowActivity）
### Clear → Trim（永遠保留最近50）
- `POST /follow-activity/autotrade/paper/clear`：改為 trim，只清 50 以外舊記錄（預設 keep=50，且 keep 最少 50）。
- `POST /follow-activity/autotrade/pending/clear`：同樣改為 trim（預設 keep=50）。

### PaperTrade 記錄落盤（避免重啟就清走）
- PaperTrade 記錄會寫入 `POLY_STATE_DIR`（或預設 state dir）內：
  - `follow-paper-history.json`

### Data Analysis（最近 N 場摘要）
- 新增：
  - `GET /follow-activity/autotrade/paper/summary?limit=50`
- 會輸出最近 N 場嘅：
  - `byResult`（simulated_filled / partial / not_filled / error）
  - `byStopReason`
  - `avgFillPct`
  - `avgLatencyMs`

## 4) Backup 注意事項
- runtime data 目錄（例如 `/var/lib/polymarket-tools`）入面嘅 `follow-paper-history.json` 要一齊備份。
- 備份清單已更新到 `docs/BACKUP-RESTORE.md`。

