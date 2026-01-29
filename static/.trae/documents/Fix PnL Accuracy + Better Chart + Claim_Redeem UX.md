## What I will change (to make redeem ASAP)

### 1) Remove the 15‑minute “dead time” behavior
- Auto Redeem will no longer just run every N minutes and sit idle.
- When enabled, it will **poll redeemables frequently** (e.g. every 30s) and trigger redeem immediately when any appear.

### 2) Add a strict 1-by-1 “drain” loop (no batching)
- Implement `redeemDrainOneByOne()`:
  - Fetch redeemable positions (`redeemable=true`).
  - Redeem **one** condition.
  - Immediately fetch again and repeat until none left.
  - Hard stop on repeated errors to avoid infinite loops.

### 3) Make it “fast” by not waiting minutes per redeem
- The biggest latency is waiting for confirmations.
- I will change relayer redeem so we:
  - submit the redeem tx
  - record `transactionID/txHash` immediately (as soon as relayer returns it)
  - continue to the next redeem as soon as the relayer has accepted the tx (sequential; no parallel; nonce-safe)
  - a background poller updates each tx to CONFIRMED/FAILED and updates `lastError`/history.

This makes the system *start* redemption immediately and keep pushing the queue, instead of “1 redeem → wait many minutes → next redeem”.

### 4) Add a single endpoint to trigger the drain now
- `POST /api/group-arb/redeem-drain`:
  - starts the 1-by-1 drain loop immediately
  - returns progress: remaining redeemables, in-flight txs, successes/failures

### 5) Verification
- After implementing, I will verify:
  - multiple redeemables are processed back-to-back (seconds apart) rather than 15m apart
  - Data API redeemable count drops quickly
  - history shows tx ids/hashes and final states

If you approve, I’ll implement these backend changes only (no UI work), then run a drain and confirm the redeemable count drops.