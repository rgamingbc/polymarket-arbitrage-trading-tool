import assert from 'node:assert/strict';
import { runSweepBuyLiveBurst } from '../services/sweep-buy.js';

const asks = [
    { price: 0.95, size: 10 },
    { price: 0.96, size: 10 },
    { price: 0.97, size: 10 },
    { price: 0.98, size: 10 },
    { price: 0.99, size: 10 },
];

const orderDb = new Map<string, { status: string; filledSize: number; price: number }>();
let idSeq = 0;

const res = await runSweepBuyLiveBurst({
    tokenId: 'token1',
    priceCap: 0.99,
    budgetUsd: 50,
    maxOrders: 5,
    maxConcurrent: 3,
    fetchAsks: async () => asks as any,
    placeOrder: async ({ amountUsd, priceCap }) => {
        idSeq += 1;
        const orderId = `order_${idSeq}`;
        const filledUsd = Math.max(0, Math.min(amountUsd, 10));
        const filledSize = priceCap > 0 ? (filledUsd / priceCap) : 0;
        orderDb.set(orderId, { status: 'MATCHED', filledSize, price: priceCap });
        return { success: true, orderId, errorMsg: null };
    },
    getOrder: async (orderId: string) => {
        const o = orderDb.get(orderId);
        return o ? { status: o.status, filledSize: o.filledSize, price: o.price } : { status: 'OPEN', filledSize: 0, price: null };
    },
    pollTimeoutMs: 200,
    pollIntervalMs: 50,
    maxLevels: 200,
});

assert.equal(res.ok, true);
assert.ok(res.orders.length >= 1);
assert.ok(Number(res.summary.totalFilledUsd) > 0);
assert.ok(Number(res.summary.totalFilledShares) > 0);
assert.ok(Number(res.summary.totalOrders) >= 1);

console.log('OK: sweep-burst smoke');
