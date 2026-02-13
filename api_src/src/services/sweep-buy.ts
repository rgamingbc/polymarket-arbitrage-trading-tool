import { computeAskDepthUsd } from '../utils/orderbook-depth.js';

export type SweepBuyOrderLog = {
    submittedAt: string;
    roundtripMs: number;
    statusLatencyMs: number | null;
    success: boolean;
    attemptedUsd: number;
    orderId: string | null;
    orderStatus: string | null;
    filledSize: number | null;
    orderPrice: number | null;
    errorMsg: string | null;
};

export type SweepBuySummary = {
    mode: 'live' | 'demo';
    tokenId: string;
    priceCap: number;
    budgetUsd: number;
    depthCapUsd: number | null;
    levelsUsed: number | null;
    totalOrders: number;
    totalAttemptedUsd: number;
    totalFilledUsd: number;
    totalFilledShares: number;
    avgFillPrice: number | null;
    stopReason: string | null;
};

export type SweepBuyResult = {
    ok: boolean;
    orders: SweepBuyOrderLog[];
    summary: SweepBuySummary;
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

const normalizeAsks = (asks: any[]) => {
    return (Array.isArray(asks) ? asks : [])
        .map((a: any) => {
            const price = Number(a?.price);
            const size = Number(a?.size ?? a?.amount ?? a?.quantity);
            if (!Number.isFinite(price) || price <= 0) return null;
            if (!Number.isFinite(size) || size <= 0) return null;
            return { price, size };
        })
        .filter(Boolean) as Array<{ price: number; size: number }>;
};

export const simulateSweepBuy = (params: {
    tokenId: string;
    asks: any[];
    priceCap: number;
    budgetUsd: number;
    maxLevels?: number;
}) => {
    const tokenId = String(params.tokenId || '').trim();
    const priceCap = clamp(Number(params.priceCap), 0.001, 0.999);
    const budgetUsd = Math.max(0, Number(params.budgetUsd) || 0);
    const maxLevels = Math.max(1, Math.floor(Number(params.maxLevels ?? 200)));
    const asks = normalizeAsks(params.asks);
    asks.sort((a, b) => a.price - b.price);

    const depth = computeAskDepthUsd({ asks, limitPrice: priceCap, targetUsd: budgetUsd, maxLevels });
    const depthCapUsd = depth.depthUsd;
    const spend = Math.max(0, Math.min(budgetUsd, Number.isFinite(depthCapUsd) ? depthCapUsd : 0));

    let remaining = spend;
    let fillUsd = 0;
    let fillShares = 0;
    let levelsConsumed = 0;
    for (const lvl of asks) {
        if (lvl.price > priceCap + 1e-12) break;
        const lvlUsd = lvl.size * lvl.price;
        const takeUsd = Math.min(remaining, lvlUsd);
        if (takeUsd <= 0) break;
        fillUsd += takeUsd;
        fillShares += takeUsd / lvl.price;
        remaining -= takeUsd;
        levelsConsumed += 1;
        if (remaining <= 1e-9) break;
    }
    const avgFillPrice = fillShares > 0 ? fillUsd / fillShares : null;
    const stopReason =
        budgetUsd <= 0 ? 'no_budget'
            : !(Number.isFinite(depthCapUsd) && depthCapUsd > 0) ? 'no_depth'
                : fillUsd <= 0 ? 'no_fill'
                    : fillUsd + 1e-9 < spend ? 'partial_fill'
                        : 'filled';

    const summary: SweepBuySummary = {
        mode: 'demo',
        tokenId,
        priceCap,
        budgetUsd,
        depthCapUsd,
        levelsUsed: levelsConsumed || depth.levelsUsed,
        totalOrders: levelsConsumed,
        totalAttemptedUsd: spend,
        totalFilledUsd: fillUsd,
        totalFilledShares: fillShares,
        avgFillPrice,
        stopReason,
    };
    const orders: SweepBuyOrderLog[] = [
        {
            submittedAt: new Date().toISOString(),
            roundtripMs: 0,
            statusLatencyMs: 0,
            success: fillUsd > 0,
            attemptedUsd: spend,
            orderId: null,
            orderStatus: 'SIMULATED',
            filledSize: fillShares,
            orderPrice: avgFillPrice,
            errorMsg: null,
        }
    ];
    return { ok: fillUsd > 0, orders, summary } as SweepBuyResult;
};

export const runSweepBuyLive = async (params: {
    tokenId: string;
    priceCap: number;
    budgetUsd: number;
    maxOrders: number;
    minIntervalMs: number;
    fetchAsks: () => Promise<any[]>;
    placeOrder: (input: { amountUsd: number; priceCap: number }) => Promise<{ success: boolean; orderId?: string | null; errorMsg?: string | null }>;
    getOrder: (orderId: string) => Promise<{ status?: string | null; filledSize?: number | null; price?: number | null }>;
    pollTimeoutMs?: number;
    pollIntervalMs?: number;
    maxLevels?: number;
}) => {
    const tokenId = String(params.tokenId || '').trim();
    const priceCap = clamp(Number(params.priceCap), 0.001, 0.999);
    const budgetUsd = Math.max(0, Number(params.budgetUsd) || 0);
    const maxOrders = Math.max(1, Math.floor(Number(params.maxOrders) || 1));
    const minIntervalMs = Math.max(0, Math.floor(Number(params.minIntervalMs) || 0));
    const pollTimeoutMs = Math.max(0, Math.floor(Number(params.pollTimeoutMs ?? 1200)));
    const pollIntervalMs = Math.max(50, Math.floor(Number(params.pollIntervalMs ?? 150)));
    const maxLevels = Math.max(1, Math.floor(Number(params.maxLevels ?? 200)));

    let attemptedUsd = 0;
    let filledUsd = 0;
    let filledShares = 0;
    let ordersCount = 0;
    let stopReason: string | null = null;
    let lastDepthCap: number | null = null;
    let lastLevelsUsed: number | null = null;
    const orders: SweepBuyOrderLog[] = [];

    while (ordersCount < maxOrders) {
        const remainingBudget = budgetUsd - attemptedUsd;
        if (!(remainingBudget > 0)) { stopReason = 'budget_exhausted'; break; }
        const asks = await params.fetchAsks();
        const depth = computeAskDepthUsd({ asks, limitPrice: priceCap, targetUsd: remainingBudget, maxLevels });
        const depthCapUsd = depth.depthUsd * 0.95;
        lastDepthCap = depthCapUsd;
        lastLevelsUsed = depth.levelsUsed;
        if (!(Number.isFinite(depthCapUsd) && depthCapUsd >= 1)) { stopReason = 'no_depth'; break; }

        const amountUsd = Math.max(1, Math.min(remainingBudget, depthCapUsd));
        const submittedAtMs = Date.now();
        const submittedAt = new Date(submittedAtMs).toISOString();

        const res = await params.placeOrder({ amountUsd, priceCap });
        const returnedAtMs = Date.now();
        const roundtripMs = returnedAtMs - submittedAtMs;
        const orderId = res?.orderId != null ? String(res.orderId) : null;
        const ok = res?.success === true;
        const errorMsg = res?.errorMsg != null ? String(res.errorMsg) : (!ok ? 'order_rejected' : null);

        attemptedUsd += amountUsd;
        ordersCount += 1;

        let orderStatus: string | null = ok ? 'SUBMITTED' : `failed:${String(errorMsg || 'order_failed').slice(0, 160)}`;
        let statusLatencyMs: number | null = null;
        let filledSize: number | null = null;
        let orderPrice: number | null = null;

        if (ok && orderId) {
            const deadline = Date.now() + pollTimeoutMs;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, pollIntervalMs));
                const o = await params.getOrder(orderId).catch(() => null);
                const st = o?.status != null ? String(o.status) : '';
                const fs = o?.filledSize != null ? Number(o.filledSize) : NaN;
                const op = o?.price != null ? Number(o.price) : NaN;
                if (!statusLatencyMs && st) statusLatencyMs = Date.now() - submittedAtMs;
                orderStatus = st || orderStatus;
                filledSize = Number.isFinite(fs) ? fs : filledSize;
                orderPrice = Number.isFinite(op) ? op : orderPrice;
                if (st && st.toLowerCase() !== 'open') break;
            }
        }

        const fillSharesThis = filledSize != null && Number.isFinite(Number(filledSize)) ? Number(filledSize) : 0;
        const fillUsdThis = orderPrice != null && Number.isFinite(Number(orderPrice)) ? fillSharesThis * Number(orderPrice) : 0;
        filledShares += Math.max(0, fillSharesThis);
        filledUsd += Math.max(0, fillUsdThis);

        orders.push({
            submittedAt,
            roundtripMs,
            statusLatencyMs,
            success: ok,
            attemptedUsd: amountUsd,
            orderId,
            orderStatus: orderStatus || null,
            filledSize: filledSize != null ? Number(filledSize) : null,
            orderPrice: orderPrice != null ? Number(orderPrice) : null,
            errorMsg,
        });

        if (!ok) { stopReason = 'order_failed'; break; }
        if (!(fillUsdThis > 0)) { stopReason = 'no_fill'; break; }

        if (minIntervalMs > 0 && ordersCount < maxOrders) {
            await new Promise((r) => setTimeout(r, minIntervalMs));
        }
    }

    const avgFillPrice = filledShares > 0 ? filledUsd / filledShares : null;
    const summary: SweepBuySummary = {
        mode: 'live',
        tokenId,
        priceCap,
        budgetUsd,
        depthCapUsd: lastDepthCap,
        levelsUsed: lastLevelsUsed,
        totalOrders: ordersCount,
        totalAttemptedUsd: attemptedUsd,
        totalFilledUsd: filledUsd,
        totalFilledShares: filledShares,
        avgFillPrice,
        stopReason,
    };

    const ok = filledUsd > 0 && orders.some((o) => !(String(o.orderStatus || '').toLowerCase().startsWith('failed:')));
    return { ok, orders, summary } as SweepBuyResult;
};

const isRateLimited = (msg: string | null | undefined) => {
    const m = String(msg || '').toLowerCase();
    return m.includes('429') || m.includes('too many') || m.includes('rate limit') || m.includes('ratelimit');
};

export const runSweepBuyLiveBurst = async (params: {
    tokenId: string;
    priceCap: number;
    budgetUsd: number;
    maxOrders: number;
    maxConcurrent?: number;
    fetchAsks: () => Promise<any[]>;
    placeOrder: (input: { amountUsd: number; priceCap: number }) => Promise<{ success: boolean; orderId?: string | null; errorMsg?: string | null }>;
    getOrder?: (orderId: string) => Promise<{ status?: string | null; filledSize?: number | null; price?: number | null }>;
    pollTimeoutMs?: number;
    pollIntervalMs?: number;
    windowMs?: number;
    roundIntervalMs?: number;
    maxRounds?: number;
    maxLevels?: number;
}) => {
    const tokenId = String(params.tokenId || '').trim();
    const priceCap = clamp(Number(params.priceCap), 0.001, 0.999);
    const budgetUsd = Math.max(0, Number(params.budgetUsd) || 0);
    const maxOrders = Math.max(1, Math.floor(Number(params.maxOrders) || 1));
    const maxConcurrent = Math.max(1, Math.min(12, Math.floor(Number(params.maxConcurrent ?? 5))));
    const maxLevels = Math.max(1, Math.floor(Number(params.maxLevels ?? 200)));
    const pollTimeoutMs = Math.max(0, Math.floor(Number(params.pollTimeoutMs ?? 1200)));
    const pollIntervalMs = Math.max(50, Math.floor(Number(params.pollIntervalMs ?? 150)));
    const windowMs = Math.max(0, Math.floor(Number(params.windowMs ?? 0)));
    const roundIntervalMs = Math.max(0, Math.floor(Number(params.roundIntervalMs ?? 350)));
    const maxRounds = Math.max(1, Math.floor(Number(params.maxRounds ?? 50)));

    const execRound = async (planned: Array<{ amountUsd: number; priceCap: number }>) => {
        const results: Array<SweepBuyOrderLog | null> = Array(planned.length).fill(null);
        let nextIdx = 0;
        let rateLimited = false;
        const worker = async () => {
            while (true) {
                if (rateLimited) return;
                const i = nextIdx;
                nextIdx += 1;
                if (i >= planned.length) return;
                const p = planned[i];
                const submittedAtMs = Date.now();
                const submittedAt = new Date(submittedAtMs).toISOString();
                try {
                    const res = await params.placeOrder({ amountUsd: p.amountUsd, priceCap: p.priceCap });
                    const returnedAtMs = Date.now();
                    const roundtripMs = returnedAtMs - submittedAtMs;
                    const orderId = res?.orderId != null ? String(res.orderId) : null;
                    const ok = res?.success === true;
                    const errorMsg = res?.errorMsg != null ? String(res.errorMsg) : (!ok ? 'order_rejected' : null);
                    if (isRateLimited(errorMsg)) rateLimited = true;
                    let orderStatus: string | null = ok ? 'SUBMITTED' : `failed:${String(errorMsg || 'order_failed').slice(0, 160)}`;
                    let statusLatencyMs: number | null = null;
                    let filledSize: number | null = null;
                    let orderPrice: number | null = null;
                    if (ok && orderId && typeof params.getOrder === 'function') {
                        const deadline = Date.now() + pollTimeoutMs;
                        while (Date.now() < deadline) {
                            await new Promise((r) => setTimeout(r, pollIntervalMs));
                            const o = await params.getOrder(orderId).catch(() => null);
                            const st = o?.status != null ? String(o.status) : '';
                            const fs = o?.filledSize != null ? Number(o.filledSize) : NaN;
                            const op = o?.price != null ? Number(o.price) : NaN;
                            if (!statusLatencyMs && st) statusLatencyMs = Date.now() - submittedAtMs;
                            if (st) orderStatus = st;
                            if (Number.isFinite(fs)) filledSize = fs;
                            if (Number.isFinite(op)) orderPrice = op;
                            if (st && st.toLowerCase() !== 'open') break;
                        }
                    }
                    results[i] = {
                        submittedAt,
                        roundtripMs,
                        statusLatencyMs,
                        success: ok,
                        attemptedUsd: p.amountUsd,
                        orderId,
                        orderStatus,
                        filledSize,
                        orderPrice,
                        errorMsg,
                    };
                } catch (e: any) {
                    const msg = e?.message || String(e || 'order_failed');
                    if (isRateLimited(msg)) rateLimited = true;
                    results[i] = {
                        submittedAt,
                        roundtripMs: 0,
                        statusLatencyMs: null,
                        success: false,
                        attemptedUsd: p.amountUsd,
                        orderId: null,
                        orderStatus: `failed:${String(msg || 'order_failed').slice(0, 160)}`,
                        filledSize: null,
                        orderPrice: null,
                        errorMsg: String(msg || 'order_failed'),
                    };
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(maxConcurrent, planned.length) }, () => worker()));
        return { results, rateLimited };
    };

    let attemptedUsd = 0;
    let ordersCount = 0;
    let filledUsd = 0;
    let filledShares = 0;
    let stopReason: string | null = null;
    let depthCapUsd: number | null = null;
    let levelsUsed: number | null = null;
    const orders: SweepBuyOrderLog[] = [];

    const deadlineMs = windowMs > 0 ? (Date.now() + windowMs) : Date.now();
    let rounds = 0;
    let zeroFillRounds = 0;
    while (rounds < maxRounds) {
        const budgetRemaining = budgetUsd - filledUsd;
        if (!(budgetRemaining >= 1)) { stopReason = 'budget_exhausted'; break; }
        if (ordersCount >= maxOrders) { stopReason = 'done'; break; }
        if (windowMs > 0 && Date.now() > deadlineMs) { stopReason = 'done'; break; }

        const asksRaw = await params.fetchAsks();
        const asks = normalizeAsks(asksRaw).sort((a, b) => a.price - b.price).slice(0, maxLevels);
        const ladderPrices = Array.from(new Set(
            asks
                .filter((x) => x.price <= priceCap + 1e-12)
                .map((x) => Number(x.price))
                .filter((p) => Number.isFinite(p) && p > 0)
        )).sort((a, b) => b - a);

        if (!ladderPrices.length) { stopReason = budgetUsd <= 0 ? 'no_budget' : 'no_depth'; break; }

        const ordersRemaining = maxOrders - ordersCount;
        const ladder = ladderPrices.slice(0, Math.max(1, Math.min(ordersRemaining, ladderPrices.length)));
        const planned: Array<{ amountUsd: number; priceCap: number }> = [];
        let remaining = budgetRemaining;
        for (let i = 0; i < ordersRemaining; i++) {
            if (!(remaining >= 1)) break;
            const price = ladder[i % ladder.length];
            const left = ordersRemaining - i;
            const raw = left > 0 ? (remaining / left) : remaining;
            const amt = Math.max(1, Math.min(remaining, Math.round(raw * 100) / 100));
            planned.push({ amountUsd: amt, priceCap: price });
            remaining -= amt;
        }
        depthCapUsd = budgetRemaining - remaining;
        levelsUsed = planned.length;
        if (!planned.length) { stopReason = 'no_depth'; break; }

        const { results, rateLimited } = await execRound(planned);
        if (rateLimited) { stopReason = 'rate_limited'; break; }

        let filledUsdRound = 0;
        for (const r of results) {
            if (!r) continue;
            attemptedUsd += Number(r.attemptedUsd) || 0;
            ordersCount += 1;
            orders.push(r);
            const fs = r.filledSize != null && Number.isFinite(Number(r.filledSize)) ? Number(r.filledSize) : 0;
            const op = r.orderPrice != null && Number.isFinite(Number(r.orderPrice)) ? Number(r.orderPrice) : NaN;
            const usd = Number.isFinite(op) ? fs * op : 0;
            filledShares += Math.max(0, fs);
            filledUsd += Math.max(0, usd);
            filledUsdRound += Math.max(0, usd);
        }

        rounds += 1;
        if (filledUsdRound <= 0) zeroFillRounds += 1;
        else zeroFillRounds = 0;
        if (zeroFillRounds >= 3) { stopReason = 'no_fill'; break; }

        if (windowMs > 0 && Date.now() <= deadlineMs && roundIntervalMs > 0) {
            await new Promise((r) => setTimeout(r, roundIntervalMs));
        } else if (windowMs <= 0) {
            break;
        }
    }

    if (!stopReason) stopReason = filledUsd > 0 ? 'done' : (budgetUsd <= 0 ? 'no_budget' : 'no_fill');
    const summary: SweepBuySummary = {
        mode: 'live',
        tokenId,
        priceCap,
        budgetUsd,
        depthCapUsd: depthCapUsd ?? 0,
        levelsUsed: levelsUsed ?? 0,
        totalOrders: ordersCount,
        totalAttemptedUsd: attemptedUsd,
        totalFilledUsd: filledUsd,
        totalFilledShares: filledShares,
        avgFillPrice: filledShares > 0 ? (filledUsd / filledShares) : null,
        stopReason,
    };

    const ok = filledUsd > 0 && orders.some((o) => o.success === true && !(String(o.orderStatus || '').toLowerCase().startsWith('failed:')));
    return { ok, orders, summary } as SweepBuyResult;
};
