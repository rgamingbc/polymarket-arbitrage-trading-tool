import assert from 'node:assert/strict';
import { buildFollowActivitySuggestions, normalizeFollowActivityConfig } from '../services/follow-activity.js';

const cfg = normalizeFollowActivityConfig({
    address: '0x0000000000000000000000000000000000000001',
    pollMs: 2000,
    limit: 200,
    queryMode: 'auto',
    types: ['TRADE'],
    sides: ['BUY'],
    includeKeywords: ['btc'],
    excludeKeywords: [],
    ratio: 0.05,
    maxUsdcPerOrder: 10,
    maxUsdcPerDay: 20,
} as any);

const events: any[] = [
    {
        type: 'TRADE',
        side: 'BUY',
        size: 100,
        price: 0.1,
        usdcSize: 10,
        asset: 'asset1',
        conditionId: 'cond1',
        outcome: 'Up',
        timestamp: Date.now(),
        transactionHash: '0xabc',
        title: 'BTC Up or Down',
        slug: 'btc-updown-15m',
    },
    {
        type: 'TRADE',
        side: 'BUY',
        size: 100,
        price: 0.2,
        usdcSize: 20,
        asset: 'asset2',
        conditionId: 'cond2',
        outcome: 'Down',
        timestamp: Date.now(),
        transactionHash: '0xdef',
        title: 'ETH Up or Down',
        slug: 'eth-updown-15m',
    },
];

const s1 = buildFollowActivitySuggestions(events, cfg, 0);
assert.equal(s1.length, 1);
assert.equal(s1[0]?.conditionId, 'cond1');
assert.ok(s1[0]?.myUsdc <= 10);

const s2 = buildFollowActivitySuggestions(events, cfg, 15);
assert.equal(s2.length, 1);
assert.ok(s2[0]?.myUsdc <= 5);

console.log('OK: follow-activity smoke');
