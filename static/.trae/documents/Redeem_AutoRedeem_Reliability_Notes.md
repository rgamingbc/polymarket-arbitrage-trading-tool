# Redeem / Auto Redeem Reliability Notes

## How to know a redeem is successful
- **Tool truth**: A redeem is successful only when there is a confirmed onchain result (tx hash confirmed) *and/or* the Polymarket Data API no longer lists that position as `redeemable=true`.
- **Quick checks (recommended order)**:
  1. `GET /api/group-arb/history?refresh=true&intervalMs=1000&maxEntries=20`
     - Look for the latest `action: "redeem"` entry.
     - For each result:
       - `success: true` + `confirmed: true` and a `txHash` = confirmed redeem.
       - `redeemStatus: "submitted"` means the relayer accepted it but it is not yet confirmed.
       - `success: false` + `errorSummary` describes the blocker.
  2. `GET /api/group-arb/redeem/diagnose?limit=50`
     - `diagnostics.redeemableCount` should drop after successful redeems.
  3. Polymarket portfolio UI “Claim” disappearing can lag; refresh after a minute.

## Why you see many red error lines
- The history table shows **execution errors**, not P/L.
- Common meanings:
  - `RPC unreachable`: backend cannot reach Polygon RPC (non-relayer paths fail).
  - `Insufficient gas (MATIC)`: Owner wallet cannot pay gas (non-relayer paths fail).
  - `Relayer auth failed`: Builder credentials rejected by relayer.

## Auto Redeem behavior (current)
- Auto Redeem polls every **5 seconds** and triggers a one-by-one redeem drain when enabled.
- Auto Redeem configuration persists to a local file so it survives backend restarts.

### Auto Redeem config file
- Exposed in: `GET /api/group-arb/auto-redeem/status`
  - `configPath`, `configFilePresent`, `configPersistedAt`, `configPersistLastError`

### Relayer config file
- Exposed in: `GET /api/group-arb/relayer/status`
  - `configPath`, `configFilePresent`, `configPersistedAt`, `configPersistLastError`
- If relayer auth fails during a test redeem, the backend clears the config (and deletes the persisted relayer file).

## Useful endpoints
- **Relayer**
  - `GET /api/group-arb/relayer/status`
  - `POST /api/group-arb/relayer/config` (writes relayer config to disk by default)
- **Redeem**
  - `GET /api/group-arb/redeem/diagnose`
  - `GET /api/group-arb/redeem/in-flight`
  - `POST /api/group-arb/redeem-drain` (submits one-by-one quickly)
  - `POST /api/group-arb/redeem/conditions` (redeem specific conditionIds; always writes a history entry)
- **History**
  - `GET /api/group-arb/history?refresh=true&intervalMs=1000&maxEntries=20`

## Current blocker checklist
- If `relayerConfigured=false` and you see `RPC unreachable` or `Insufficient gas`, redeems cannot complete via non-relayer path.
- To make redeems reliable without requiring MATIC top-ups, ensure:
  - `relayerConfigured=true`
  - relayer config file is present (`configFilePresent=true`)

## Relayer quota exceeded
- If history shows `Relayer quota exceeded`, the Builder Relayer API key has no remaining quota until reset.
- In that case, redeems will not be workable via our relayer until:
  - the quota resets, or
  - you switch to a different Builder key with available quota, or
  - you fund the Owner wallet with a small amount of MATIC and use non-relayer redeem.
