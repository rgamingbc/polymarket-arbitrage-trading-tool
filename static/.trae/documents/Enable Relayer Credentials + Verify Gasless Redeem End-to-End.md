## Key change to match your request
- Add a **Dashboard input box next to Funder/Relayer** where you paste:
  - Builder API key
  - Builder secret
  - Builder passphrase
- When you click **Save**, frontend sends them to backend; backend configures the relayer **in-memory** (no file writes), so you don’t need to edit `.env`.

## Security constraints
- I will **not** write these secrets into any repo file, and I will **not** print them in logs.
- Since you already pasted them into chat, **rotate/revoke them** in your Builder profile as soon as possible.

## Backend implementation
1. Add `POST /api/group-arb/relayer/config`
   - Body: `{ apiKey, secret, passphrase, relayerUrl? }`
   - Stores creds in memory and initializes `BuilderConfig` + `RelayClient` instances.
   - Returns `{ success, relayerConfigured, error? }`.

2. Make Safe relayer path robust
   - If using `RelayerTxType.SAFE`, call `client.deploy()` once before first `execute()` (per Polymarket docs).

3. Add `GET /api/group-arb/relayer/status`
   - Returns `relayerConfigured`, `relayerUrl`, and last init error (no secrets).

## Frontend (Dashboard) implementation
1. Add “Relayer Setup” inline form in the Redeem (Auto) section
   - 3 password inputs + Save button
   - Optional relayer URL input (default `https://relayer-v2.polymarket.com`)
   - After Save: clear the inputs from UI state
   - Show status label: `Relayer: configured / not configured` based on `/relayer/status`

## Automatic verification (I will run it after you enter keys)
1. Call `/api/group-arb/redeem/diagnose` to confirm redeemables exist.
2. Trigger a real redeem via `/api/group-arb/redeem-now` (max=1).
3. Confirm success:
   - Response includes `txHash`
   - `method` starts with `relayer_...`
   - Dashboard shows last redeem run with `ok > 0` and no `lastError`

If you approve, I’ll implement the new backend endpoints + Dashboard inputs, then run the redeem verification end-to-end as soon as you paste the keys in the new UI box.