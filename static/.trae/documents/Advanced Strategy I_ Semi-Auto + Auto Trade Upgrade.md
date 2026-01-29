## Immediate Issue: UI Not Opening (localhost:5173)
- Your screenshot shows `ERR_CONNECTION_REFUSED` on `localhost:5173/advanced`.
- That means the web dashboard dev server is not running (or crashed) or the port changed.

## Strategy Name
**Advanced Strategy I: Twin‑Leg Discount Ladder (TDL)**

## What Will Be Implemented (Execution Scope)
### 1) Make “Buy All” use Shares (Size) as the primary input
- Replace “Investment Amount (USDC)” with **Shares**.
- Keep **estimated USDC cost** as read-only calculated output.
- Add min-size guardrails (avoid order rejects).

### 2) Add a Settings Interface (Semi‑Auto)
Add a settings panel (saved locally in browser + optionally persisted server-side later) for:
- Target profit % (or target total cost per set, default 10% / 0.90)
- Default shares
- Cut-loss %
- Trailing stop % from peak
- Spread thresholds (e.g. “wide spread mode”)
- One-leg timeout (minutes) before forced action

### 3) Preserve Semi‑Auto, Clone into Auto Trade
- Keep your click-to-trade as **Semi‑Auto** (you remain in control).
- Add a new menu under 高級策略: **自動交易**.
- Auto Trade is OFF by default with an explicit enable toggle + kill switch.
- Auto Trade reuses the same engine but runs on a schedule.

### 4) Unified Trade History + Dashboard Tags
- Every action writes a history record with a clear tag:
  - `manual` / `semi` / `auto`
- Dashboard enhancements:
  - Filters by tag
  - Separate performance counters per tag
  - Combined view for “all trades”

### 5) Correct Target Pricing Math (Fix the model)
- Use one consistent scaling factor so total target cost per set matches the profit goal.
- Example: if asks sum = 1.12 and target cost = 0.90 → factor = 0.90/1.12 = 0.8036.
- Target bids become YES_ask×factor and NO_ask×factor (then tick-round).

### 6) One‑Leg Monitoring State Machine (Risk Engine)
Implement a robust state machine for partial fills:
- none → orders_live → one_leg_filled → both_legs_filled → exited
Rules (all configurable from settings):
- If one leg filled and price drops beyond cut-loss → immediate exit
- If price rises then drops X% from peak → trailing exit
- Spread-aware execution (best bid vs aggressive) with thresholds

### 7) Scanner Ranking Upgrade (Spread + Time + Ratio)
- Add explicit metrics in scan output:
  - Combined spread, per-leg spread, liquidity/depth hints
  - Time-to-deadline filters
  - Ratio closeness score (50/50, 40/60, 30/70 as a ranking boost)
- Sort priority: higher profit (lower cost) AND thinner spread AND safer time window.

## Execution Order (How I Will Deliver It)
1) Restore your dashboard dev access (start API + web dev servers; confirm `/advanced` route loads).
2) Update Buy‑All UI to shares-first + estimate cost.
3) Add Settings UI + persist locally.
4) Add trade provenance tags and dashboard filters.
5) Implement one-leg monitoring state machine (Semi‑Auto only; Auto remains OFF).
6) Upgrade scanner metrics + sorting.
7) Add “自動交易” menu with OFF-by-default scaffolding.

## Verification
- UI: `/advanced` loads; Buy‑All submits orders using shares.
- API: returns tagged history entries; dashboard shows tags/filters.
- Safety: Auto Trade remains OFF unless explicitly enabled.

If you confirm, I will start by bringing `localhost:5173` back online and then implement Strategy I (TDL) step-by-step.