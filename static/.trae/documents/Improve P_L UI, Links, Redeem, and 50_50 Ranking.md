## Immediate clarification (why claim is blocked today)
- Claim/Redeem is an **on-chain transaction** (`CTF.redeemPositions(...)`). On Polygon, that normally requires **gas paid in MATIC**.
- Polymarket.com can make “Claim” feel gasless because it uses relayers/proxy execution. Polymarket’s docs describe redeem as calling `redeemPositions` on-chain: https://docs.polymarket.com/developers/CTF/redeem#reedeeming-tokens
- Your normal CLOB API key **cannot** pay gas for redeem.

## Good news: your Builder credentials solve this
- You provided **builder secret + passphrase**, and you previously showed a builder key id.
- With these, I can integrate Polymarket’s **Builder Relayer** so claim/redeem can be **gasless** (no MATIC needed).
- I will NOT write your secret/passphrase into code. I will wire the backend to read them from environment variables.

## Plan (prioritize “help me do the claim”)
### 1) Wire Builder Relayer into backend redeem flow (gasless)
- Add env config keys:
  - `POLY_BUILDER_API_KEY`
  - `POLY_BUILDER_SECRET`
  - `POLY_BUILDER_PASSPHRASE`
  - (optional) `POLY_RELAYER_URL` default `https://relayer-v2.polymarket.com`
- Add a small relayer client module that can execute one transaction:
  - target = CTF contract `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
  - data = encoded `redeemPositions(USDCe, 0x0, conditionId, [1,2])`
- Determine wallet type automatically:
  - if funder != signer → treat as proxy wallet flow; else EOA
- Add logging to history: for each redeem attempt record tx hash / relayer state.

### 2) Add “Redeem Diagnose” endpoint so we can verify your pending claim
- New endpoint returns:
  - funder (proxy wallet), signer (owner)
  - relayer configured yes/no
  - list of redeemable positions from Data API (`redeemable=true`) including `title/slug/eventSlug/conditionId/proxyWallet`
- This will show exactly **which market is claimable** and whether it is being attempted.

### 3) Fix Dashboard “Redeem (Auto) unavailable”
- Dashboard: call `fetchRedeemStatus()` inside `refreshAll()` and on first load.
- UI: show “Relayer configured ✅ / ❌” instead of generic unavailable.

### 4) Turn on real auto-redeem “time to time”
- Auto redeem loop:
  - every N minutes, call Data API redeemable positions
  - redeem them via relayer
  - record last run summary

### 5) Fix 50/50 ranking exactly (51/49, 52/48 first)
- Remove the client-side re-sorting in `Advanced.tsx` that currently overrides backend order.
- Show explicit balance label:
  - `51/49`, `60/40` computed from YES/(YES+NO)

### 6) Add proper event links for Open Orders and Trades
- Backend enrich open orders/trades with `{slug, eventSlug, title}` per marketId using Gamma/Data API.
- UI build links exactly like your example:
  - `https://polymarket.com/event/{eventSlug}/{slug}`

### 7) Performance UI: match Polymarket (not cashflow)
- Replace “trade cashflow/buy/sell volume” cards with Polymarket-style:
  - `Profit/Loss` + timeframe buttons (1D/1W/1M/ALL)
  - small line chart similar to Polymarket
- Implement by storing periodic snapshots of portfolio value/PnL and graphing deltas.

## Verification steps after implementation
- Click “Redeem Now” → should return a relayer tx hash and your Polymarket “Claim” should disappear.
- Auto-redeem status should show configured + last run.
- Advanced list should show the closest-to-50/50 opportunities first.
- Open orders / trades should have working event links.

## Security note
- I will add `.env` wiring only; secrets will not be committed or printed.

If you accept, I will start implementing immediately, beginning with the relayer claim path so your pending redeem can be claimed first.