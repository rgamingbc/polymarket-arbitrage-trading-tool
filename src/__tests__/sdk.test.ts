/**
 * PolymarketSDK 单元测试
 *
 * 测试 SDK 的核心功能：
 * - 市场获取 (getMarket)
 * - 订单簿获取 (getOrderbook)
 * - 套利检测 (detectArbitrage)
 * - 价格工具函数 (getEffectivePrices, checkArbitrage)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PolymarketSDK } from '../index.js';
import { getEffectivePrices, checkArbitrage } from '../utils/price-utils.js';
import { MockRateLimiter, MockCache, mockClobMarket } from './test-utils.js';

describe('PolymarketSDK', () => {
    let sdk: PolymarketSDK;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockFetch = vi.fn();
        global.fetch = mockFetch;
        sdk = new PolymarketSDK();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getMarket', () => {
        it('应该通过 conditionId 获取市场', async () => {
            // Mock CLOB API 响应
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    condition_id: mockClobMarket.conditionId,
                    question: mockClobMarket.question,
                    description: mockClobMarket.description,
                    market_slug: mockClobMarket.marketSlug,
                    tokens: [
                        { token_id: 'yes-token', outcome: 'Yes', price: 0.65 },
                        { token_id: 'no-token', outcome: 'No', price: 0.35 },
                    ],
                    accepting_orders: true,
                    end_date_iso: mockClobMarket.endDateIso,
                    active: true,
                    closed: false,
                }),
            });

            const market = await sdk.getMarket(mockClobMarket.conditionId);

            expect(market.conditionId).toBe(mockClobMarket.conditionId);
            expect(market.tokens.yes.price).toBe(0.65);
            expect(market.tokens.no.price).toBe(0.35);
        });

        it('应该对不存在的市场抛出错误', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                json: async () => ({ error: 'Market not found' }),
            });

            await expect(sdk.getMarket('invalid-condition-id')).rejects.toThrow();
        });
    });

    describe('getOrderbook', () => {
        it('应该获取处理后的订单簿', async () => {
            // Mock getMarket
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

            // Mock YES orderbook
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    bids: [{ price: '0.55', size: '1000' }],
                    asks: [{ price: '0.57', size: '800' }],
                }),
            });

            // Mock NO orderbook
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    bids: [{ price: '0.43', size: '900' }],
                    asks: [{ price: '0.45', size: '700' }],
                }),
            });

            const orderbook = await sdk.getOrderbook(mockClobMarket.conditionId);

            expect(orderbook.yes.bid).toBe(0.55);
            expect(orderbook.yes.ask).toBe(0.57);
            expect(orderbook.no.bid).toBe(0.43);
            expect(orderbook.no.ask).toBe(0.45);
            expect(orderbook.summary).toBeDefined();
        });
    });

    describe('detectArbitrage', () => {
        it('应该检测到多头套利机会', async () => {
            // Mock getMarket
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

            // Mock YES orderbook - 低卖价
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    bids: [{ price: '0.48', size: '1000' }],
                    asks: [{ price: '0.47', size: '800' }],
                }),
            });

            // Mock NO orderbook - 低卖价
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    bids: [{ price: '0.48', size: '900' }],
                    asks: [{ price: '0.47', size: '700' }],
                }),
            });

            const arb = await sdk.detectArbitrage(mockClobMarket.conditionId, 0.01);

            // YES ask (0.47) + NO ask (0.47) = 0.94 < 1.0
            // 利润 = 1 - 0.94 = 0.06 (6%)
            expect(arb).not.toBeNull();
            expect(arb?.type).toBe('long');
            expect(arb?.profit).toBeGreaterThan(0.01);
        });

        it('应该在无套利机会时返回 null', async () => {
            // Mock getMarket
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

            // Mock YES orderbook - 正常价格
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    bids: [{ price: '0.50', size: '1000' }],
                    asks: [{ price: '0.52', size: '800' }],
                }),
            });

            // Mock NO orderbook - 正常价格
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    bids: [{ price: '0.48', size: '900' }],
                    asks: [{ price: '0.50', size: '700' }],
                }),
            });

            const arb = await sdk.detectArbitrage(mockClobMarket.conditionId, 0.01);

            // YES ask (0.52) + NO ask (0.50) = 1.02 > 1.0，无套利
            expect(arb).toBeNull();
        });
    });
});

describe('价格工具函数', () => {
    describe('getEffectivePrices', () => {
        it('应该正确计算有效价格', () => {
            // YES: bid=0.55, ask=0.57
            // NO:  bid=0.43, ask=0.45
            const effective = getEffectivePrices(0.57, 0.55, 0.45, 0.43);

            // effectiveBuyYes = min(YES.ask, 1 - NO.bid) = min(0.57, 0.57) = 0.57
            expect(effective.effectiveBuyYes).toBeCloseTo(0.57, 2);

            // effectiveBuyNo = min(NO.ask, 1 - YES.bid) = min(0.45, 0.45) = 0.45
            expect(effective.effectiveBuyNo).toBeCloseTo(0.45, 2);

            // effectiveSellYes = max(YES.bid, 1 - NO.ask) = max(0.55, 0.55) = 0.55
            expect(effective.effectiveSellYes).toBeCloseTo(0.55, 2);

            // effectiveSellNo = max(NO.bid, 1 - YES.ask) = max(0.43, 0.43) = 0.43
            expect(effective.effectiveSellNo).toBeCloseTo(0.43, 2);
        });
    });

    describe('checkArbitrage', () => {
        it('应该检测到多头套利', () => {
            // YES ask=0.47, NO ask=0.47 → 总成本=0.94 < 1.0
            const arb = checkArbitrage(0.47, 0.47, 0.50, 0.50);

            expect(arb).not.toBeNull();
            expect(arb?.type).toBe('long');
            expect(arb?.profit).toBeCloseTo(0.06, 2);
        });

        it('应该检测到空头套利', () => {
            // YES bid=0.55, NO bid=0.55 → 总收入=1.10 > 1.0
            const arb = checkArbitrage(0.60, 0.60, 0.55, 0.55);

            expect(arb).not.toBeNull();
            expect(arb?.type).toBe('short');
            expect(arb?.profit).toBeCloseTo(0.10, 2);
        });

        it('无套利机会时返回 null', () => {
            // 正常市场，无套利
            const arb = checkArbitrage(0.52, 0.50, 0.50, 0.48);

            expect(arb).toBeNull();
        });
    });
});

describe('镜像订单簿概念', () => {
    it('买 YES @ P = 卖 NO @ (1-P)', () => {
        // 这是 Polymarket 的核心概念
        // 一个 "卖 NO @ 0.40" 的订单等同于 "买 YES @ 0.60"

        const yesAsk = 0.60;  // YES 卖价
        const noBid = 0.40;   // NO 买价

        // 有效买 YES 价格 = min(YES ask, 1 - NO bid)
        const effectiveBuyYes = Math.min(yesAsk, 1 - noBid);
        expect(effectiveBuyYes).toBe(0.60);

        // 如果 NO bid > 1 - YES ask，则通过卖 NO 买 YES 更划算
        const noBidHigher = 0.45;
        const effectiveBuyYes2 = Math.min(yesAsk, 1 - noBidHigher);
        expect(effectiveBuyYes2).toBe(0.55);  // 通过卖 NO 实现
    });
});
