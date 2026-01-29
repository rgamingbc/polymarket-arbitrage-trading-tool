## Clarification: “Redeem fee gasless” is possible
- You’re right: **CTF operations (split/merge/redeem) are gasless when executed via Polymarket’s Builder Relayer through a Safe/Proxy flow** (Polymarket pays gas) per the relayer/builder docs.
- In our app, that gasless path only activates when the backend has Builder credentials configured (so `Relayer: configured`). In your screenshot, it shows `Relayer: not configured`, so the code currently falls back to **direct onchain** redeem (EOA/safe/proxy contract calls), which needs the Owner to have MATIC.
- Separately, even when Auto Redeem is enabled, it won’t show activity until it actually runs (default interval 15 minutes). So “not working” can mean either “hasn’t run yet” or “ran but failed due to missing relayer/gas”.

## Goals (based on your message)
- Make Auto Redeem visibly working (run now + show next run + show errors).
- Make Profit/Loss accurate and styled like Polymarket (portfolio value, cash, P/L card + chart).
- Add filters/boxes for strategy separation (manual/auto/semi/external) and order status.

## Backend work
1. **Auto Redeem: run-now + observability**
   - When enabling Auto Redeem, trigger a redeem cycle immediately (or within ~5s) instead of waiting full interval.
   - Extend status payload to include `nextRunAt`, `lastRunAt`, `lastError`, `lastResultSummary` so UI can show what happened.
   - Log failures into history (not only successes) so you can diagnose in Dashboard.

2. **Portfolio summary endpoint (Polymarket-style)**
   - Add `GET /api/group-arb/portfolio-summary` returning:
     - `portfolioValue` from Polymarket Data API `GET /value` (docs: https://docs.polymarket.com/developers/misc-endpoints/data-api-value)
     - `positionsValue` (same as above)
     - `cash` (USDC.e on Polygon for funder/proxy wallet)
     - `claimableCount` (count of redeemable positions from Data API `GET /positions`)
   - This lets the frontend display “Portfolio” and “Cash” like Polymarket.

3. **Fix Profit/Loss semantics**
   - Replace current P/L snapshots based on `sum(cashPnl)` with a portfolio-equity series:
     - `equity = cash + positionsValue`
     - `P/L(range) = equity(now) - equity(startOfRange)`
   - Persist snapshots to disk so 1D/1W/1M/ALL remains meaningful after server restarts.

4. **Strategy + external separation**
   - Tag every tool-generated order/trade/history row with `strategy` (`manual|auto|semi`) and a `source` (`tool|external`).
   - Build mapping from tool orderIds to strategy so we can classify fills consistently.

5. **Order status visibility**
   - Expose normalized status fields for open orders and history rows (`OPEN/FILLED/CANCELED/FAILED`), and include last-known CLOB status.

## Frontend (Dashboard) work
1. **Polymarket-inspired top cards**
   - Show:
     - Portfolio (big)
     - Cash (small)
     - Profit/Loss (big) + timeframe chips + mini line chart
     - Claim button when `claimableCount > 0`

2. **Filters / boxes you requested**
   - Add filter controls:
     - Strategy: All / Manual / Auto / Semi / External
     - Order status: All / Open / Filled / Canceled / Failed
     - P/L mode: Portfolio P/L vs Trade cashflow (keep existing cashflow endpoint as “Cashflow P/L”)

3. **Auto Redeem UX**
   - Show `Next run in …`, `Last run …`, and last error.
   - Add “Run now” button separate from “Enable”.

## Verification
- Enable Auto Redeem and confirm a run happens immediately and status updates.
- Compare Portfolio/Cash displayed with Polymarket portfolio page.
- Confirm P/L is baseline-relative (matches Polymarket mental model).
- Confirm filters change tables and separate tool vs external activity.

If you accept this plan, I’ll implement it end-to-end (backend + frontend) and verify in the running dev servers.