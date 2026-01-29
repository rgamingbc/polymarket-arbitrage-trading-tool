# 15m Crypto Up/Down Strategy

## What It Does

- Scans Polymarket’s 15m crypto Up/Down markets (BTC/ETH/SOL).
- Shows candidates in UI and lets you place a “semi” (one-click) market buy.
- Auto mode places a buy only when both conditions are met:
  - `meetsMinProb`: best side price ≥ `minProb`
  - `eligibleByExpiry`: market ends within `expiresWithinSec`
- Auto redeem is enabled alongside auto mode so resolved positions get claimed.

## End Time Note

Polymarket 15m event slugs look like `*-updown-15m-<unixSeconds>`.
In practice `<unixSeconds>` is the window start; the scanner treats the end as `start + 900s`.

## UI

- Open: `/crypto-15m`
- Controls:
  - Min Prob: `minProb` threshold for auto (UI still shows all candidates)
  - Expire ≤ (sec): `expiresWithinSec` window for auto
  - Amount ($): order notional in USDC
  - Start Auto Trade / Stop
  - Bid: places one order for the row’s chosen side

## API Endpoints

Base: `/api/group-arb`

- `GET /crypto15m/candidates?minProb=&expiresWithinSec=&limit=`
  - Returns `candidates[]` with:
    - `meetsMinProb` and `eligibleByExpiry` flags
    - `chosenOutcome`, `chosenPrice`, `secondsToExpire`
- `GET /crypto15m/status`
- `POST /crypto15m/auto/start` body: `{ amountUsd, minProb, expiresWithinSec, pollMs }`
- `POST /crypto15m/auto/stop`
- `POST /crypto15m/order` body: `{ conditionId, outcomeIndex, amountUsd }`

## Relayer / Redeem

Gasless redeem uses the builder relayer. If you see `401 invalid authorization`, switch active key:

- `POST /api/group-arb/relayer/active` body: `{ "activeIndex": <number>, "persist": true }`

Then retry:

- `POST /api/group-arb/redeem-now` body: `{ "max": 1 }`

## Where Things Live

- Scanner + strategy: `api_src/src/services/group-arbitrage.ts`
- Routes: `api_src/src/routes/group-arb.ts`
- UI page: `web_front_src/src/pages/Crypto15m.tsx`
