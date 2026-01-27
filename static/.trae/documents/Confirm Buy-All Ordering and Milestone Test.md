## Confirm “Buy All” Can Order
- Yes. The system can place real orders (it already produced LIVE orders with returned orderIds). The remaining goal is to make your next test reproducible with your exact ladder prices.

## Your Updated Test Requirement
- Use **fixed size = 5** (ignore 2 USDC budget).
- Target market (Ankara):
  - https://polymarket.com/event/highest-temperature-in-ankara-on-january-28/highest-temperature-in-ankara-on-january-28-9c
- Target maker bids:
  - NO: place at **$0.58** (you called this “3rd row” style)
  - YES: place at **$0.24**
  - Size: **5** for both legs

## What I Will Implement (so you can test once and log it)
1) **Resolve market from event URL/slug**
- Add an API helper that accepts the event URL or slug and resolves to conditionId + YES/NO tokenIds.

2) **Orderbook ladder preview (top levels)**
- Add an endpoint that returns top bids/asks for YES and NO (e.g. top 5), plus tickSize.
- Purpose: confirm the ladder you’re referencing (e.g. best bid ~0.56 on NO, best bid ~0.26 on YES) and validate your target prices are on-tick.

3) **Manual Buy-All execute (fixed size)**
- Add `POST /api/group-arb/execute-manual` that takes:
  - identifier (event url / slug / marketId)
  - yesPrice (0.24), noPrice (0.58)
  - size (5)
  - orderType (default GTC)
- It places two BUY orders (YES + NO), returns orderIds, and fetches openOrders for that market.

4) **Always record the attempt**
- Ensure the manual execute writes a history entry so Dashboard shows:
  - the market
  - both legs (YES/NO)
  - orderId + error/status if rejected

## Milestone 1 “Success” Definition
- API returns 2 orderIds
- `open-orders` shows 2 LIVE orders for that market
- Dashboard shows the attempt in history and open orders

## Milestone 2 (after success)
- Implement the automation/state-machine (partial fills, 3-hour rules, best-bid exit, etc.).

If you confirm, I will implement the new preview + manual fixed-size Buy-All flow and then we’ll run the Ankara test exactly at YES 0.24 / NO 0.58 / size 5.