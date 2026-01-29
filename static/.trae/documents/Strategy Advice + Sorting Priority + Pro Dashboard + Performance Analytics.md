## Clarifications (addressing your notes)

### 1) Auto Redeem: yes, same topic
- Yes — “redeem” here means exactly what you do on Polymarket: **click Redeem to receive cash after resolution**.
- It’s an on-chain action (Polygon gas required).

### 2) Auto Redeem should include your own Polymarket trades (not only our tool)
Agreed — that’s much more useful.
- Instead of limiting to “our Global Order History”, I’ll add an auto-redeem scanner that looks at **your actual wallet positions**.
- Source of positions:
  - Primary: Polymarket data API (portfolio/positions for your wallet/proxy)
  - Fallback: positions implied by our history (if data API is temporarily down)
- For each position whose market is resolved, it will attempt `redeem(conditionId)`.

### 3) “Aggressive exit” should be clearly marked in logs
Agreed.
- Any forced exit (cut-loss / trailing / manual Exit Now) will record a **remark tag** like:
  - `remark: 'risk_exit_aggressive_market'`
  - `reason: 'cut_loss' | 'trailing_stop' | 'force_market_from_peak' | 'manual_exit'`
So you’ll immediately know: “system intentionally sold aggressively; loss is expected/accepted.”

### 4) Remove extra complexity; keep the most effective fallback
Agreed.
- I will NOT add a long verification loop or chunked selling right now.
- I will implement the simple and effective policy:
  - Try market FAK sell
  - If it fails → place an **aggressive limit sell at bestBid** (or bestBid adjusted by tick)
  - Always write a clear remark in history

## Feature plan (what I will implement after you confirm)

### A) Improve one-leg risk exits (no silent exposure)
- Keep the fix: never mark exited when sell fails.
- Add the fallback: market FAK → aggressive limit @ bestBid.
- Add `remark` fields to history for any aggressive exit.

### B) Opportunity ranking priority (your rule)
- Change sorting to:
  1) ratioScore DESC (closest 50/50)
  2) spreadSum ASC (thin spread)
  3) totalCost ASC (profit tie-break)
  4) liquidity DESC

### C) Dashboard: professional monitoring UX
- Add missing links (Market / Portfolio / Tx) everywhere.
- Add “Active Risk” panel + quick actions (Monitor / Cancel / Exit Now).
- Show the new `remark`/`reason` so exits are explainable.

### D) Performance / P&L by timeframe and strategy
- Add 1D / 1W / 1M / All.
- Attribute by strategy:
  - semi / manual / auto / external
- Tag trades using orderId matching when possible; unmatched trades stay `external`.

### E) Auto Redeem (manual + automatic)
- Add endpoints:
  - `POST /redeem-now` (redeem everything resolvable now)
  - `POST /auto-redeem/config` (enable + interval)
  - `GET /auto-redeem/status` (last run + tx results)
- Add UI:
  - Redeem Now button
  - Auto Redeem toggle + interval setting
  - Redeem history log (txHash, success/error)

## Safety defaults
- Hedge-Complete remains OFF by default.
- Auto Redeem defaults OFF.
- All redeem/exit actions are logged with clear remarks.

If you confirm, I’ll implement A→E in that order and then we can validate with: one small trade + one forced cut-loss/Exit Now + one test redeem on a resolved market.