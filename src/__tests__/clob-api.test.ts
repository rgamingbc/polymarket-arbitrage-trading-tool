/**
 * CLOB API Client Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClobApiClient } from '../clients/clob-api.js';
import {
  MockRateLimiter,
  MockCache,
  mockClobMarket,
  mockOrderbook,
  mockNoOrderbook,
  expectOrderbookSorted,
} from './test-utils.js';

describe('ClobApiClient', () => {
  let client: ClobApiClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    client = new ClobApiClient(
      new MockRateLimiter() as never,
      new MockCache() as never
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getMarket', () => {
    it('should fetch and normalize market data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          condition_id: mockClobMarket.conditionId,
          question: mockClobMarket.question,
          description: mockClobMarket.description,
          market_slug: mockClobMarket.marketSlug,
          tokens: mockClobMarket.tokens.map((t) => ({
            token_id: t.tokenId,
            outcome: t.outcome,
            price: t.price,
          })),
          accepting_orders: true,
          end_date_iso: mockClobMarket.endDateIso,
          active: true,
          closed: false,
        }),
      });

      const market = await client.getMarket(mockClobMarket.conditionId);

      expect(market.conditionId).toBe(mockClobMarket.conditionId);
      expect(market.question).toBe(mockClobMarket.question);
      expect(market.tokens).toHaveLength(2);
      expect(market.tokens[0].tokenId).toBe(mockClobMarket.tokens[0].tokenId);
      expect(market.acceptingOrders).toBe(true);
    });

    it('should throw error for non-existent market', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Market not found' }),
      });

      await expect(client.getMarket('invalid-id')).rejects.toThrow();
    });

    it('should cache market data', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          condition_id: mockClobMarket.conditionId,
          question: mockClobMarket.question,
          tokens: [],
          accepting_orders: true,
          active: true,
          closed: false,
        }),
      });

      // First call
      await client.getMarket(mockClobMarket.conditionId);
      // Second call should use cache
      await client.getMarket(mockClobMarket.conditionId);

      // Should only fetch once due to caching
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getOrderbook', () => {
    it('should fetch and sort orderbook correctly', async () => {
      // Return unsorted data to test sorting
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bids: [
            { price: '0.53', size: '750' },
            { price: '0.55', size: '1000' },
            { price: '0.54', size: '500' },
          ],
          asks: [
            { price: '0.58', size: '600' },
            { price: '0.57', size: '800' },
            { price: '0.59', size: '400' },
          ],
        }),
      });

      const orderbook = await client.getOrderbook('test-token-id');

      // Check bids are sorted descending
      expect(orderbook.bids[0].price).toBe(0.55);
      expect(orderbook.bids[1].price).toBe(0.54);
      expect(orderbook.bids[2].price).toBe(0.53);

      // Check asks are sorted ascending
      expect(orderbook.asks[0].price).toBe(0.57);
      expect(orderbook.asks[1].price).toBe(0.58);
      expect(orderbook.asks[2].price).toBe(0.59);

      expectOrderbookSorted(orderbook);
    });

    it('should handle empty orderbook', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bids: [], asks: [] }),
      });

      const orderbook = await client.getOrderbook('test-token-id');

      expect(orderbook.bids).toHaveLength(0);
      expect(orderbook.asks).toHaveLength(0);
      expect(orderbook.timestamp).toBeGreaterThan(0);
    });

    it('should convert string prices to numbers', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bids: [{ price: '0.55', size: '1000.5' }],
          asks: [{ price: '0.57', size: '800.25' }],
        }),
      });

      const orderbook = await client.getOrderbook('test-token-id');

      expect(typeof orderbook.bids[0].price).toBe('number');
      expect(typeof orderbook.bids[0].size).toBe('number');
      expect(orderbook.bids[0].price).toBe(0.55);
      expect(orderbook.bids[0].size).toBe(1000.5);
    });
  });

  describe('getProcessedOrderbook', () => {
    it('should calculate effective prices correctly', async () => {
      // First call: getMarket
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          condition_id: mockClobMarket.conditionId,
          tokens: [
            { token_id: 'yes-token', outcome: 'Yes', price: 0.55 },
            { token_id: 'no-token', outcome: 'No', price: 0.45 },
          ],
          accepting_orders: true,
          active: true,
          closed: false,
        }),
      });

      // Second call: getOrderbook for YES
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bids: [{ price: '0.55', size: '1000' }],
          asks: [{ price: '0.57', size: '800' }],
        }),
      });

      // Third call: getOrderbook for NO
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bids: [{ price: '0.43', size: '900' }],
          asks: [{ price: '0.45', size: '700' }],
        }),
      });

      const processed = await client.getProcessedOrderbook(mockClobMarket.conditionId);

      // Check YES orderbook
      expect(processed.yes.bid).toBe(0.55);
      expect(processed.yes.ask).toBe(0.57);

      // Check NO orderbook
      expect(processed.no.bid).toBe(0.43);
      expect(processed.no.ask).toBe(0.45);

      // Check effective prices
      // effectiveBuyYes = min(YES.ask, 1 - NO.bid) = min(0.57, 0.57) = 0.57
      expect(processed.summary.effectivePrices.effectiveBuyYes).toBeCloseTo(0.57, 6);
      // effectiveBuyNo = min(NO.ask, 1 - YES.bid) = min(0.45, 0.45) = 0.45
      expect(processed.summary.effectivePrices.effectiveBuyNo).toBeCloseTo(0.45, 6);

      // Long cost = effectiveBuyYes + effectiveBuyNo = 0.57 + 0.45 = 1.02
      expect(processed.summary.effectiveLongCost).toBeCloseTo(1.02, 2);

      // Long arb profit = 1 - longCost = -0.02 (no opportunity)
      expect(processed.summary.longArbProfit).toBeCloseTo(-0.02, 2);
    });

    it('should detect long arbitrage opportunity', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          condition_id: mockClobMarket.conditionId,
          tokens: [
            { token_id: 'yes-token', outcome: 'Yes', price: 0.50 },
            { token_id: 'no-token', outcome: 'No', price: 0.50 },
          ],
          accepting_orders: true,
          active: true,
          closed: false,
        }),
      });

      // YES orderbook with low ask
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bids: [{ price: '0.48', size: '1000' }],
          asks: [{ price: '0.49', size: '800' }],  // Low ask
        }),
      });

      // NO orderbook with low ask
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          bids: [{ price: '0.48', size: '900' }],
          asks: [{ price: '0.49', size: '700' }],  // Low ask
        }),
      });

      const processed = await client.getProcessedOrderbook(mockClobMarket.conditionId);

      // Long cost = 0.49 + 0.49 = 0.98 < 1.00
      // Long arb profit = 1 - 0.98 = 0.02 (2% opportunity!)
      expect(processed.summary.longArbProfit).toBeGreaterThan(0);
      expect(processed.summary.longArbProfit).toBeCloseTo(0.02, 2);
    });

    it('should throw error if tokens are missing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          condition_id: mockClobMarket.conditionId,
          tokens: [],  // No tokens
          accepting_orders: true,
          active: true,
          closed: false,
        }),
      });

      await expect(
        client.getProcessedOrderbook(mockClobMarket.conditionId)
      ).rejects.toThrow('Missing tokens');
    });
  });

  describe('hasTradingCapabilities', () => {
    it('should return false without config', () => {
      expect(client.hasTradingCapabilities()).toBe(false);
    });

    it('should return true with signer', () => {
      const clientWithSigner = new ClobApiClient(
        new MockRateLimiter() as never,
        new MockCache() as never,
        { signer: {} }
      );
      expect(clientWithSigner.hasTradingCapabilities()).toBe(true);
    });

    it('should return true with credentials', () => {
      const clientWithCreds = new ClobApiClient(
        new MockRateLimiter() as never,
        new MockCache() as never,
        { creds: { key: 'k', secret: 's', passphrase: 'p' } }
      );
      expect(clientWithCreds.hasTradingCapabilities()).toBe(true);
    });
  });
});
