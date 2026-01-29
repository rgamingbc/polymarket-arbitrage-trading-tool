## What to do right after you place the trade
- In Advanced → Global Order History, note the newest entry’s: marketId, slug, results (each leg’s orderId).
- In Polymarket UI, note whether you see open orders and/or a filled position.

## What I will check (backend truth source)
- History (with 1s refresh status): `GET /api/group-arb/history?refresh=1&intervalMs=1000&maxEntries=20`
  - Verify each leg: orderStatus (LIVE/CANCELED/FILLED), filledSize, canceledBy.
- Open orders for that market: `GET /api/group-arb/orders?marketId=<marketId>`
  - Confirm whether an unfilled leg is actually live on the book.
- Recent trades (market-filtered): `GET /api/group-arb/trades?marketId=<marketId>`
  - Confirm whether the “missing leg” truly never matched, or matched then got reverted/failed.
- Diagnose bundle (openOrders + trades in one response): `GET /api/group-arb/diagnose?marketId=<marketId>`

## What we’ll conclude from the data
- If a leg has no orderId: it never placed (order creation failed).
- If orderStatus is CANCELED:
  - canceledBy=system → timeout/exit cancel
  - canceledBy=external → manual/UI cancel or other client
- If orderStatus is LIVE but Polymarket UI shows none: it’s usually UI caching/filters; we’ll compare orderId directly.

## Controls to keep safe while you test
- Keep **Enable Hedge-Complete = OFF** (A/B default).
- For “no unexpected cancel” testing: set **Auto-cancel Unfilled Leg on Timeout = OFF** (even if timeout is ON).

## After you trade, send me just these 3 things
- The market URL (or marketId)
- Screenshot of the newest History entry (showing both legs)
- Whether you clicked “Exit Now” or canceled anything manually

If you confirm, I’ll run the above checks immediately after your trade and summarize exactly why any leg did/didn’t complete.