## Answer
- Polymarket relayer usage is gated by a **daily relayer transaction limit per Builder tier**: **Unverified: 100/day**, **Verified: 1,500/day**, **Partner: Unlimited**.[[2]](https://docs.polymarket.com/developers/builders/builder-tiers)
- Separately, relayer endpoints also have **rate limits** (example: **RELAYER /submit 25 requests / minute**).[[1]](https://docs.polymarket.com/quickstart/introduction/rate-limits)
- The error we saw (`quota exceeded: 0 units remaining, resets in … seconds`) is consistent with hitting the **daily relayer txn limit** for the builder key.[[2]](https://docs.polymarket.com/developers/builders/builder-tiers)

## Is providing a bunch of Builder API keys helpful?
- Yes—**if each key is Unverified (100/day)**, adding multiple keys increases total daily capacity (e.g., 10 keys ≈ 1,000 relayer tx/day), and lets Auto Redeem keep running longer.
- But it only works if we implement **automatic key rotation** on “quota exceeded” and track which keys are exhausted until reset.
- Longer-term, the best fix is upgrading to **Verified** or **Partner** so you don’t need key rotation at all.[[2]](https://docs.polymarket.com/developers/builders/builder-tiers)

## Implementation Plan (no changes yet)
### 1) Support multiple builder credentials
- Update relayer config format to store an **array of credentials** (apiKey/secret/passphrase + optional label) and an **active index**.
- Keep backward compatibility: if the old single-key config exists, treat it as a 1-item list.

### 2) Auto-rotate on quota exceeded
- When a relayer call fails with **quota exceeded**, mark that key as **exhausted** with a `resetAt` (derived from the error’s “resets in X seconds” when available).
- Automatically switch to the next non-exhausted key.
- If all keys are exhausted, pause auto-redeem and show a clear status.

### 3) Better status + reporting
- Extend `/api/group-arb/relayer/status` to include:
  - active key label/id (masked)
  - per-key state: OK / exhausted / auth failed / unknown
  - next reset time if known
- Ensure redeem attempts always write to our tool history with per-item outcome, links, and (when available) txHash.

### 4) UI updates
- Add a “Relayer Keys” manager:
  - Add/remove keys, reorder, select active
  - Show each key’s status (OK/exhausted + reset countdown)

### 5) Verification
- Add a local test path that simulates quota errors to verify:
  - rotation happens
  - history logs are correct
  - auto-redeem pauses only when all keys are exhausted

If you confirm this plan, I’ll implement it and then re-run redeem against your 3 claimables using the rotated keys until either confirmed or all keys are exhausted.