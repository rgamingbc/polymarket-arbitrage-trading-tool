/**
 * CLOB API Client Integration Tests
 *
 * These tests make REAL API calls to Polymarket.
 * They verify that:
 * 1. API endpoints are reachable
 * 2. Response structures match our types
 * 3. Data normalization works correctly
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ClobApiClient } from '../../clients/clob-api.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { createUnifiedCache } from '../../core/unified-cache.js';

describe('ClobApiClient Integration', () => {
  let client: ClobApiClient;

  beforeAll(() => {
    client = new ClobApiClient(new RateLimiter(), createUnifiedCache());
  });

  describe('getMarket', () => {
    it('should fetch a real market from Polymarket', async () => {
      // Get trending markets first to find a valid condition ID
      const response = await fetch(
        'https://gamma-api.polymarket.com/markets?active=true&limit=1&order=volume24hr&ascending=false'
      );
      const markets = await response.json() as Array<{ conditionId: string }>;

      if (markets.length === 0) {
        console.log('No active markets found, skipping test');
        return;
      }

      const conditionId = markets[0].conditionId;
      const market = await client.getMarket(conditionId);

      // Verify structure
      expect(market.conditionId).toBe(conditionId);
      expect(typeof market.question).toBe('string');
      expect(market.question.length).toBeGreaterThan(0);
      expect(Array.isArray(market.tokens)).toBe(true);
      expect(market.tokens.length).toBeGreaterThanOrEqual(2);

      // Verify tokens
      for (const token of market.tokens) {
        expect(typeof token.tokenId).toBe('string');
        expect(token.tokenId.length).toBeGreaterThan(0);
        expect(['Yes', 'No']).toContain(token.outcome);
        expect(typeof token.price).toBe('number');
        expect(token.price).toBeGreaterThanOrEqual(0);
        expect(token.price).toBeLessThanOrEqual(1);
      }

      // Verify other fields
      expect(typeof market.active).toBe('boolean');
      expect(typeof market.closed).toBe('boolean');
      expect(typeof market.acceptingOrders).toBe('boolean');

      console.log(`✓ Successfully fetched market: "${market.question.slice(0, 50)}..."`);
    }, 30000);

    it('should handle non-existent market gracefully', async () => {
      await expect(
        client.getMarket('0x0000000000000000000000000000000000000000000000000000000000000000')
      ).rejects.toThrow();
    }, 30000);
  });

  describe('getOrderbook', () => {
    it('should fetch real orderbook data', async () => {
      // First get a market to get token ID
      const response = await fetch(
        'https://gamma-api.polymarket.com/markets?active=true&limit=1&order=volume24hr&ascending=false'
      );
      const markets = await response.json() as Array<{ conditionId: string }>;

      if (markets.length === 0) {
        console.log('No active markets found, skipping test');
        return;
      }

      const market = await client.getMarket(markets[0].conditionId);
      const yesToken = market.tokens.find(t => t.outcome === 'Yes');

      if (!yesToken) {
        console.log('No YES token found, skipping test');
        return;
      }

      const orderbook = await client.getOrderbook(yesToken.tokenId);

      // Verify structure
      expect(Array.isArray(orderbook.bids)).toBe(true);
      expect(Array.isArray(orderbook.asks)).toBe(true);
      expect(typeof orderbook.timestamp).toBe('number');
      expect(orderbook.timestamp).toBeGreaterThan(0);

      // Verify bids are sorted descending (if any exist)
      for (let i = 1; i < orderbook.bids.length; i++) {
        expect(orderbook.bids[i].price).toBeLessThanOrEqual(orderbook.bids[i - 1].price);
      }

      // Verify asks are sorted ascending (if any exist)
      for (let i = 1; i < orderbook.asks.length; i++) {
        expect(orderbook.asks[i].price).toBeGreaterThanOrEqual(orderbook.asks[i - 1].price);
      }

      // Verify price/size types
      if (orderbook.bids.length > 0) {
        expect(typeof orderbook.bids[0].price).toBe('number');
        expect(typeof orderbook.bids[0].size).toBe('number');
        expect(orderbook.bids[0].price).toBeGreaterThan(0);
        expect(orderbook.bids[0].price).toBeLessThan(1);
      }

      console.log(`✓ Orderbook: ${orderbook.bids.length} bids, ${orderbook.asks.length} asks`);
    }, 30000);
  });

  describe('getProcessedOrderbook', () => {
    it('should return complete processed orderbook with analytics', async () => {
      // Get an active market
      const response = await fetch(
        'https://gamma-api.polymarket.com/markets?active=true&limit=5&order=volume24hr&ascending=false'
      );
      const markets = await response.json() as Array<{ conditionId: string; question: string }>;

      // Find a market with good liquidity
      let processed = null;
      for (const m of markets) {
        try {
          processed = await client.getProcessedOrderbook(m.conditionId);
          if (processed.yes.bid > 0 && processed.yes.ask < 1) {
            console.log(`✓ Using market: "${m.question.slice(0, 50)}..."`);
            break;
          }
        } catch {
          continue;
        }
      }

      if (!processed) {
        console.log('No liquid market found, skipping test');
        return;
      }

      // Verify YES orderbook
      expect(typeof processed.yes.bid).toBe('number');
      expect(typeof processed.yes.ask).toBe('number');
      expect(processed.yes.bid).toBeLessThanOrEqual(processed.yes.ask);

      // Verify NO orderbook
      expect(typeof processed.no.bid).toBe('number');
      expect(typeof processed.no.ask).toBe('number');
      expect(processed.no.bid).toBeLessThanOrEqual(processed.no.ask);

      // Verify summary
      expect(typeof processed.summary.effectiveLongCost).toBe('number');
      expect(typeof processed.summary.effectiveShortRevenue).toBe('number');
      expect(typeof processed.summary.longArbProfit).toBe('number');
      expect(typeof processed.summary.shortArbProfit).toBe('number');

      // Verify effective prices
      expect(typeof processed.summary.effectivePrices.effectiveBuyYes).toBe('number');
      expect(typeof processed.summary.effectivePrices.effectiveBuyNo).toBe('number');
      expect(typeof processed.summary.effectivePrices.effectiveSellYes).toBe('number');
      expect(typeof processed.summary.effectivePrices.effectiveSellNo).toBe('number');

      // Log arbitrage info
      console.log(`  YES: bid=${processed.yes.bid.toFixed(3)}, ask=${processed.yes.ask.toFixed(3)}`);
      console.log(`  NO:  bid=${processed.no.bid.toFixed(3)}, ask=${processed.no.ask.toFixed(3)}`);
      console.log(`  Long arb profit:  ${(processed.summary.longArbProfit * 100).toFixed(3)}%`);
      console.log(`  Short arb profit: ${(processed.summary.shortArbProfit * 100).toFixed(3)}%`);
    }, 60000);

    it('should correctly calculate effective prices with mirroring', async () => {
      const response = await fetch(
        'https://gamma-api.polymarket.com/markets?active=true&limit=1&order=volume24hr&ascending=false'
      );
      const markets = await response.json() as Array<{ conditionId: string }>;

      if (markets.length === 0) return;

      const processed = await client.getProcessedOrderbook(markets[0].conditionId);

      // Verify mirroring logic:
      // effectiveBuyYes should be <= YES.ask (can't be worse than direct buy)
      expect(processed.summary.effectivePrices.effectiveBuyYes).toBeLessThanOrEqual(processed.yes.ask || 1);

      // effectiveBuyNo should be <= NO.ask
      expect(processed.summary.effectivePrices.effectiveBuyNo).toBeLessThanOrEqual(processed.no.ask || 1);

      // effectiveSellYes should be >= YES.bid (can't be worse than direct sell)
      expect(processed.summary.effectivePrices.effectiveSellYes).toBeGreaterThanOrEqual(processed.yes.bid);

      // effectiveSellNo should be >= NO.bid
      expect(processed.summary.effectivePrices.effectiveSellNo).toBeGreaterThanOrEqual(processed.no.bid);

      // Long cost should equal sum of effective buy prices
      const expectedLongCost =
        processed.summary.effectivePrices.effectiveBuyYes +
        processed.summary.effectivePrices.effectiveBuyNo;
      expect(processed.summary.effectiveLongCost).toBeCloseTo(expectedLongCost, 6);

      // Short revenue should equal sum of effective sell prices
      const expectedShortRevenue =
        processed.summary.effectivePrices.effectiveSellYes +
        processed.summary.effectivePrices.effectiveSellNo;
      expect(processed.summary.effectiveShortRevenue).toBeCloseTo(expectedShortRevenue, 6);

      console.log('✓ Effective price calculations verified');
    }, 30000);
  });
});
