import assert from 'node:assert/strict';
import { FollowAutoTrader } from '../services/follow-autotrade.js';
import type { FollowActivitySuggestion } from '../services/follow-activity.js';

const mockOrderbook = {
    asks: [
        { price: 0.9, size: 10 },
        { price: 0.91, size: 10 },
        { price: 0.92, size: 10 },
        { price: 0.93, size: 10 },
        { price: 0.94, size: 10000 },
    ],
    bids: [],
};

const trader = new FollowAutoTrader(
    async () => {
        throw new Error('getTradingClient should not be called in demo');
    },
    false,
    async () => mockOrderbook as any
);

trader.updateConfig({
    enabled: false,
    mode: 'queue',
    executionStyle: 'sweep',
    allowConditionIds: [],
    allowCategories: ['sports'],
    denyConditionIds: [],
    paperTradeEnabled: true,
    paperFillRule: 'sweep',
    paperBookLevels: 10,
    paperMinFillPct: 90,
    sweepPriceCapCents: 99.9,
    sweepMinTriggerCents: 0,
    sweepMaxUsdcPerEvent: 50,
    sweepMaxOrdersPerEvent: 10,
    sweepMinIntervalMs: 0,
} as any);

const okSuggestion: FollowActivitySuggestion = {
    id: 'tx1:cond1:token1:BUY:1:0.99',
    at: Date.now(),
    type: 'TRADE',
    side: 'BUY',
    conditionId: 'cond1',
    asset: 'token1',
    outcome: 'Yes',
    title: "Xavier Musketeers vs. St. John's Red Storm",
    slug: 'xavier-vs-stjohns',
    category: 'sports',
    leaderUsdc: 100,
    leaderPrice: 0.99,
    myUsdc: 2,
    cappedByOrder: false,
    cappedByDay: false,
};

const notAllowedSuggestion: FollowActivitySuggestion = {
    ...okSuggestion,
    id: 'tx2:cond2:token2:BUY:1:0.5',
    conditionId: 'cond2',
    asset: 'token2',
    title: 'Some Other Market',
    slug: 'some-other-market',
    category: 'other',
};

await trader.applySuggestions([okSuggestion, notAllowedSuggestion]);

const paper = trader.getPaperHistory(10);
assert.equal(paper.length, 1);
assert.equal(paper[0]?.conditionId, 'cond1');
assert.equal(paper[0]?.result, 'simulated_filled');
assert.ok(Number(paper[0]?.fillPct) >= 90);
assert.equal(String(paper[0]?.sweepStopReason || ''), 'filled');
assert.ok(Number(paper[0]?.sweepOrders || 0) >= 2);

console.log('OK: follow-demo-sweep smoke');
