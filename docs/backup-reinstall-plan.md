# Backup & Reinstall Plan (Current Repo Structure)

## Repo / Host / Branch

- Host (origin): `https://github.com/rgamingbc/polymarket-arbitrage-trading-tool.git`
- Main branch: `main`
- Working backup branch (today): `fix/relayer-multikey-backend-only-20260129`
  - Already pushed to origin.

## What Should Be Backed Up

### 1) Code

- This repo working tree (recommended: clone fresh from origin + checkout your target branch).

### 2) Runtime config files (important)

These are **local** files created by the backend at runtime:

- Relayer config:
  - Default: `${TMPDIR}/polymarket-tools/relayer.json`
  - Override via env: `POLY_RELAYER_CONFIG_PATH`
- Auto-redeem config:
  - Default: `${TMPDIR}/polymarket-tools/auto-redeem.json`
  - Override via env: `POLY_AUTO_REDEEM_CONFIG_PATH`
- History file:
  - Default: `${TMPDIR}/polymarket-tools/history.json` and `history.json.bak`
  - Override via env: `POLY_ORDER_HISTORY_PATH`
- PnL snapshots:
  - Default: `${TMPDIR}/polymarket-tools/pnl-snapshots.json`
  - Override via env: `POLY_PNL_SNAPSHOT_PATH`

Recommendation (for real machines): set all 4 env vars to a **persistent** directory (not tmp) so your config survives restarts.

### 3) Secrets (do NOT commit to git)

- Private key for Polymarket (env only).
- Relayer API keys / secrets / passphrases (stored in relayer.json locally; keep encrypted/secure).

### 4) UI fork reminder

Your UI fork repo can be used instead of the built-in UI folder:

- Current integrated UI path: `web_front_src/`
- If you want to use your own UI fork:
  - Clone your fork separately
  - Point its API baseURL to the backend URL
  - Keep route compatibility with `/api/group-arb/*`

## Backup Procedure (Recommended)

1) Backup code
   - `git clone` from origin on a clean machine
   - `git checkout fix/relayer-multikey-backend-only-20260129` (or the branch you want)

2) Backup runtime configs
   - Copy the 4 files listed above into a safe folder (e.g. `~/polymarket-tools-backup/`)
   - Verify `relayer.json` contains multiple keys and the correct activeIndex

3) Backup local DBs (optional)
   - `FKPolyTools_Repo/datas/whales.db` if you rely on it

## Reinstall / Restore Procedure

### Backend (FKPolyTools_Repo/api_src)

1) Install deps
   - `npm install` (or your team’s standard package manager)

2) Restore env vars (recommended)
   - Set:
     - `POLY_RELAYER_CONFIG_PATH`
     - `POLY_AUTO_REDEEM_CONFIG_PATH`
     - `POLY_ORDER_HISTORY_PATH`
     - `POLY_PNL_SNAPSHOT_PATH`
   - Set Polymarket private key in env (never in repo).

3) Restore runtime config files
   - Copy your backed-up `relayer.json / auto-redeem.json / history.json* / pnl-snapshots.json` into the paths above.

4) Run backend
   - `npm run dev` (serves `/api/*`)

### Frontend (FKPolyTools_Repo/web_front_src)

1) Install deps
   - `npm install`

2) Run UI
   - `npm run dev`

3) Verify UI pages
   - `/crypto-15m`
   - `/advanced` (history view)

## Smoke Test Checklist

- Relayer status shows `relayerConfigured=true` and keys loaded
- `GET /api/group-arb/crypto15m/candidates` returns BTC/ETH/SOL rows
- `POST /api/group-arb/crypto15m/order` rejects when price < 0.90 (unless forced)
- `POST /api/group-arb/redeem/conditions` does not hang when redeemable=false (skips)
