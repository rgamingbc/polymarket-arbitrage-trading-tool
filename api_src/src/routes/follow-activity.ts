import { FastifyPluginAsync } from 'fastify';
import { PolymarketSDK, RateLimiter, TradingClient } from '../../../dist/index.js';
import { FollowActivityRunner, buildFollowActivitySuggestions, normalizeFollowActivityConfig } from '../services/follow-activity.js';
import type { FollowActivityEvent } from '../services/follow-activity.js';
import { FollowAutoTrader } from '../services/follow-autotrade.js';
import { config } from '../config.js';
import os from 'os';
import path from 'path';

const sdk = new PolymarketSDK();
const rateLimiter = new RateLimiter();
const tradingClient = config.polymarket.privateKey ? new TradingClient(rateLimiter as any, { privateKey: String(config.polymarket.privateKey), chainId: 137 } as any) : null;
const getTradingClient = async () => {
    if (!tradingClient) throw new Error('POLY_PRIVKEY not configured');
    await (tradingClient as any).initialize?.();
    return tradingClient as any;
};
const getOrderbook = async (tokenId: string) => {
    const tid = String(tokenId || '').trim();
    if (!tid) throw new Error('Missing tokenId');
    const clobApi = (sdk as any)?.clobApi;
    if (clobApi?.getOrderbook) return await clobApi.getOrderbook(tid);
    const r = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tid)}`);
    if (!r.ok) throw new Error(`CLOB orderbook failed: ${r.status}`);
    return await r.json();
};
const stateDirEnv = process.env.POLY_STATE_DIR != null ? String(process.env.POLY_STATE_DIR).trim() : '';
const stateDirRaw = stateDirEnv || path.join(os.tmpdir(), 'polymarket-tools');
const stateDir = path.isAbsolute(stateDirRaw) ? stateDirRaw : path.resolve(process.cwd(), stateDirRaw);
const autoTrader = new FollowAutoTrader(getTradingClient as any, !!config.polymarket.privateKey, getOrderbook as any, { paperHistoryPath: path.join(stateDir, 'follow-paper-history.json') });

const normalizeActivitiesLite = (raw: unknown[]): FollowActivityEvent[] => {
    const list = Array.isArray(raw) ? raw : [];
    return list
        .map((a: any) => {
            const type = String(a?.type || '').toUpperCase() as any;
            const side = String(a?.side || '').toUpperCase() as any;
            const size = Number(a?.size);
            let price = Number(a?.price);
            const usdcSize = a?.usdcSize != null ? Number(a.usdcSize) : undefined;
            const asset = String(a?.asset || a?.tokenId || '').trim();
            const conditionId = String(a?.conditionId || a?.condition_id || a?.market || '').trim();
            const outcome = String(a?.outcome || '').trim();
            const timestamp = Number(a?.timestamp);
            const txRaw = String(a?.transactionHash || a?.txHash || a?.hash || a?.transaction_hash || '').trim();
            if (!type || !side) return null;
            if (!conditionId || !asset) return null;
            if (!Number.isFinite(size) || !Number.isFinite(price) || !Number.isFinite(timestamp)) return null;
            if (price > 1 && price <= 100) price = price / 100;
            const transactionHash = txRaw || `synthetic:${timestamp}:${conditionId}:${asset}:${side}:${size}:${price}`;
            return {
                type,
                side,
                size,
                price,
                usdcSize: Number.isFinite(usdcSize as any) ? usdcSize : undefined,
                asset,
                conditionId,
                outcome,
                timestamp,
                transactionHash,
                title: a?.title != null ? String(a.title) : undefined,
                slug: a?.slug != null ? String(a.slug) : undefined,
                name: a?.name != null ? String(a.name) : undefined,
            } as FollowActivityEvent;
        })
        .filter((x): x is FollowActivityEvent => !!x);
};

const fetchActivityPage = async (
    address: string,
    limit: number,
    offset: number,
    queryMode: 'user' | 'proxyWallet' | 'auto'
) => {
    const addr = String(address || '').trim();
    const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    const off = Math.max(0, Math.min(2_000_000, Math.floor(Number(offset) || 0)));

    const tryFetch = async (params: Record<string, string>) => {
        const q = new URLSearchParams({ ...params, limit: String(lim), offset: String(off) });
        const r = await fetch(`https://data-api.polymarket.com/activity?${q}`);
        if (!r.ok) throw new Error(`Data API activity failed: ${r.status}`);
        const data = (await r.json()) as unknown[];
        const raw = Array.isArray(data) ? data : [];
        return { events: normalizeActivitiesLite(raw), rawCount: raw.length };
    };

    if (queryMode === 'user') {
        return await tryFetch({ user: addr });
    }

    if (queryMode === 'proxyWallet') {
        return await tryFetch({ proxyWallet: addr });
    }

    try {
        const res = await tryFetch({ user: addr });
        if (res.rawCount) return res;
    } catch {
    }

    return await tryFetch({ proxyWallet: addr });
};

const fetchActivity = async (address: string, limit: number, queryMode: 'user' | 'proxyWallet' | 'auto') => {
    const addr = String(address || '').trim();
    const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 200)));
    if (queryMode === 'proxyWallet' || queryMode === 'auto') {
        const q = new URLSearchParams({ proxyWallet: addr, limit: String(lim) });
        const r = await fetch(`https://data-api.polymarket.com/activity?${q}`);
        if (r.ok) {
            const data = (await r.json()) as unknown[];
            const normalized = normalizeActivitiesLite(Array.isArray(data) ? data : []);
            if (normalized.length) return normalized;
            if (queryMode === 'proxyWallet') return normalized;
        } else if (queryMode === 'proxyWallet') {
            throw new Error(`Data API proxyWallet activity failed: ${r.status}`);
        }
    }
    const list = await sdk.dataApi.getActivity(addr, { limit: lim });
    return normalizeActivitiesLite(list as any);
};

const runner = new FollowActivityRunner(fetchActivity as any, {
    onNewSuggestions: async (sugs) => {
        await autoTrader.applySuggestions(sugs);
    }
});

export const followActivityRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/status', {
        schema: {
            tags: ['跟單'],
            summary: 'Get FollowActivity runner status',
        },
        handler: async () => {
            return { success: true, status: runner.getStatus() };
        }
    });

    fastify.get('/activities', {
        schema: {
            tags: ['跟單'],
            summary: 'Get recent activities for followed wallet',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', default: 100 },
                    beforeTs: { type: 'number' },
                    address: { type: 'string' },
                    offset: { type: 'number', default: 0 },
                    queryMode: { type: 'string', enum: ['user', 'proxyWallet', 'auto'] },
                }
            }
        },
        handler: async (request) => {
            const q = request.query as any;
            const limit = q?.limit != null ? Number(q.limit) : 100;
            const address = q?.address != null ? String(q.address) : '';
            const offset = q?.offset != null ? Number(q.offset) : 0;
            const queryMode = String(q?.queryMode || '').trim() as any;

            if (address) {
                const mode = queryMode === 'user' ? 'user' : queryMode === 'proxyWallet' ? 'proxyWallet' : 'auto';
                const page = await fetchActivityPage(address, limit, offset, mode);
                const nextOffset = Math.max(0, Math.floor(Number(offset) || 0)) + Math.max(0, Number(page.rawCount || 0));
                return { success: true, activities: page.events, nextOffset, hasMore: Number(page.rawCount || 0) >= Math.max(1, Math.min(500, Math.floor(Number(limit) || 100))) };
            }

            const beforeTs = q?.beforeTs != null ? Number(q.beforeTs) : null;
            const activities = runner.getEventsBefore(beforeTs, limit);
            const nextBeforeTs = activities.length ? Number(activities[activities.length - 1]?.timestamp || 0) : null;
            return { success: true, activities, nextBeforeTs };
        }
    });

    fastify.get('/suggestions', {
        schema: {
            tags: ['跟單'],
            summary: 'Get follow suggestions generated from new activities',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', default: 100 },
                    beforeAt: { type: 'number' },
                    address: { type: 'string' },
                    offset: { type: 'number', default: 0 },
                    queryMode: { type: 'string', enum: ['user', 'proxyWallet', 'auto'] },
                    types: { type: 'array', items: { type: 'string' } },
                    sides: { type: 'array', items: { type: 'string' } },
                    includeKeywords: { type: 'array', items: { type: 'string' } },
                    excludeKeywords: { type: 'array', items: { type: 'string' } },
                    ratio: { type: 'number' },
                    maxUsdcPerOrder: { type: 'number' },
                    maxUsdcPerDay: { type: 'number' },
                }
            }
        },
        handler: async (request) => {
            const q = request.query as any;
            const limit = q?.limit != null ? Number(q.limit) : 100;
            const address = q?.address != null ? String(q.address) : '';
            const offset = q?.offset != null ? Number(q.offset) : 0;

            if (address) {
                const cfg = normalizeFollowActivityConfig({
                    address,
                    pollMs: 2_000,
                    limit,
                    queryMode: q?.queryMode,
                    types: q?.types,
                    sides: q?.sides,
                    includeKeywords: q?.includeKeywords,
                    excludeKeywords: q?.excludeKeywords,
                    ratio: q?.ratio,
                    maxUsdcPerOrder: q?.maxUsdcPerOrder,
                    maxUsdcPerDay: q?.maxUsdcPerDay,
                } as any);
                const page = await fetchActivityPage(cfg.address, cfg.limit, offset, cfg.queryMode);
                const suggestions = buildFollowActivitySuggestions(page.events, cfg, 0);
                const nextOffset = Math.max(0, Math.floor(Number(offset) || 0)) + Math.max(0, Number(page.rawCount || 0));
                return { success: true, suggestions, nextOffset, hasMore: Number(page.rawCount || 0) >= cfg.limit };
            }

            const beforeAt = q?.beforeAt != null ? Number(q.beforeAt) : null;
            const suggestions = runner.getSuggestionsBefore(beforeAt, limit);
            const nextBeforeAt = suggestions.length ? Number(suggestions[suggestions.length - 1]?.at || 0) : null;
            return { success: true, suggestions, nextBeforeAt };
        }
    });

    fastify.post('/confirm', {
        schema: {
            tags: ['跟單'],
            summary: 'Confirm once: fetch activities and generate suggestions (no tracking)',
            body: {
                type: 'object',
                required: ['address'],
                properties: {
                    address: { type: 'string' },
                    limit: { type: 'number' },
                    queryMode: { type: 'string', enum: ['user', 'proxyWallet', 'auto'] },
                    types: { type: 'array', items: { type: 'string' } },
                    sides: { type: 'array', items: { type: 'string' } },
                    includeKeywords: { type: 'array', items: { type: 'string' } },
                    excludeKeywords: { type: 'array', items: { type: 'string' } },
                    ratio: { type: 'number' },
                    maxUsdcPerOrder: { type: 'number' },
                    maxUsdcPerDay: { type: 'number' },
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const b = (request.body || {}) as any;
                const cfg = normalizeFollowActivityConfig({
                    address: String(b.address || ''),
                    pollMs: 2_000,
                    limit: b.limit,
                    queryMode: b.queryMode,
                    types: b.types,
                    sides: b.sides,
                    includeKeywords: b.includeKeywords,
                    excludeKeywords: b.excludeKeywords,
                    ratio: b.ratio,
                    maxUsdcPerOrder: b.maxUsdcPerOrder,
                    maxUsdcPerDay: b.maxUsdcPerDay,
                } as any);
                const list = await fetchActivity(cfg.address, cfg.limit, cfg.queryMode);
                const events = (Array.isArray(list) ? list : []).slice().sort((a: any, c: any) => Number(c?.timestamp || 0) - Number(a?.timestamp || 0));
                const suggestions = buildFollowActivitySuggestions(events, cfg, 0);
                return { success: true, activities: events, suggestions };
            } catch (err: any) {
                return reply.status(400).send({ success: false, error: err?.message || String(err) });
            }
        }
    });

    fastify.post('/start', {
        schema: {
            tags: ['跟單'],
            summary: 'Start FollowActivity runner',
            body: {
                type: 'object',
                required: ['address'],
                properties: {
                    address: { type: 'string' },
                    pollMs: { type: 'number' },
                    limit: { type: 'number' },
                    queryMode: { type: 'string', enum: ['user', 'proxyWallet', 'auto'] },
                    types: { type: 'array', items: { type: 'string' } },
                    sides: { type: 'array', items: { type: 'string' } },
                    includeKeywords: { type: 'array', items: { type: 'string' } },
                    excludeKeywords: { type: 'array', items: { type: 'string' } },
                    ratio: { type: 'number' },
                    maxUsdcPerOrder: { type: 'number' },
                    maxUsdcPerDay: { type: 'number' },
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const b = (request.body || {}) as any;
                const cfg = normalizeFollowActivityConfig({
                    address: String(b.address || ''),
                    pollMs: b.pollMs,
                    limit: b.limit,
                    queryMode: b.queryMode,
                    types: b.types,
                    sides: b.sides,
                    includeKeywords: b.includeKeywords,
                    excludeKeywords: b.excludeKeywords,
                    ratio: b.ratio,
                    maxUsdcPerOrder: b.maxUsdcPerOrder,
                    maxUsdcPerDay: b.maxUsdcPerDay,
                } as any);
                const status = runner.start(cfg);
                return { success: true, status };
            } catch (err: any) {
                return reply.status(400).send({ success: false, error: err?.message || String(err) });
            }
        }
    });

    fastify.post('/stop', {
        schema: {
            tags: ['跟單'],
            summary: 'Stop FollowActivity runner',
        },
        handler: async () => {
            const status = runner.stop();
            return { success: true, status };
        }
    });

    fastify.get('/autotrade/status', {
        schema: {
            tags: ['跟單'],
            summary: 'Get AutoTrade status',
        },
        handler: async () => {
            return { success: true, status: autoTrader.getStatus(), config: autoTrader.getConfig() };
        }
    });

    fastify.post('/autotrade/config', {
        schema: {
            tags: ['跟單'],
            summary: 'Update AutoTrade config (allow/deny + mode)',
            body: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean' },
                    mode: { type: 'string', enum: ['queue', 'auto'] },
                    executionStyle: { type: 'string', enum: ['copy', 'sweep'] },
                    allowConditionIds: { type: 'array', items: { type: 'string' } },
                    allowCategories: { type: 'array', items: { type: 'string' } },
                    denyConditionIds: { type: 'array', items: { type: 'string' } },
                    priceBufferCents: { type: 'number' },
                    maxOrdersPerHour: { type: 'number' },
                    paperTradeEnabled: { type: 'boolean' },
                    paperFillRule: { type: 'string', enum: ['touch', 'sweep'] },
                    paperBookLevels: { type: 'number' },
                    paperMinFillPct: { type: 'number' },
                    sweepPriceCapCents: { type: 'number' },
                    sweepMinTriggerCents: { type: 'number' },
                    sweepMaxUsdcPerEvent: { type: 'number' },
                    sweepMaxOrdersPerEvent: { type: 'number' },
                    sweepMinIntervalMs: { type: 'number' },
                }
            }
        },
        handler: async (request, reply) => {
            try {
                const b = (request.body || {}) as any;
                const status = autoTrader.updateConfig({
                    enabled: b.enabled,
                    mode: b.mode,
                    executionStyle: b.executionStyle,
                    allowConditionIds: b.allowConditionIds,
                    allowCategories: b.allowCategories,
                    denyConditionIds: b.denyConditionIds,
                    priceBufferCents: b.priceBufferCents,
                    maxOrdersPerHour: b.maxOrdersPerHour,
                    paperTradeEnabled: b.paperTradeEnabled,
                    paperFillRule: b.paperFillRule,
                    paperBookLevels: b.paperBookLevels,
                    paperMinFillPct: b.paperMinFillPct,
                    sweepPriceCapCents: b.sweepPriceCapCents,
                    sweepMinTriggerCents: b.sweepMinTriggerCents,
                    sweepMaxUsdcPerEvent: b.sweepMaxUsdcPerEvent,
                    sweepMaxOrdersPerEvent: b.sweepMaxOrdersPerEvent,
                    sweepMinIntervalMs: b.sweepMinIntervalMs,
                } as any);
                return { success: true, status, config: autoTrader.getConfig() };
            } catch (err: any) {
                return reply.status(400).send({ success: false, error: err?.message || String(err) });
            }
        }
    });

    fastify.get('/autotrade/paper/status', {
        schema: {
            tags: ['跟單'],
            summary: 'Get PaperTrade status',
        },
        handler: async () => {
            return { success: true, status: autoTrader.getPaperStatus(), config: autoTrader.getConfig() };
        }
    });

    fastify.get('/autotrade/paper/history', {
        schema: {
            tags: ['跟單'],
            summary: 'Get PaperTrade history',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', default: 200 },
                }
            }
        },
        handler: async (request) => {
            const q = request.query as any;
            const limit = q?.limit != null ? Number(q.limit) : 200;
            return { success: true, history: autoTrader.getPaperHistory(limit) };
        }
    });

    fastify.get('/autotrade/paper/summary', {
        schema: {
            tags: ['跟單'],
            summary: 'Get PaperTrade summary (last N)',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', default: 50 },
                }
            }
        },
        handler: async (request) => {
            const q = request.query as any;
            const limit = q?.limit != null ? Number(q.limit) : 50;
            const list = autoTrader.getPaperHistory(limit);
            const byResult: Record<string, number> = {};
            const byStopReason: Record<string, number> = {};
            let fillPctSum = 0;
            let fillPctN = 0;
            let latencySum = 0;
            let latencyN = 0;
            for (const r of Array.isArray(list) ? list : []) {
                const res = String((r as any)?.result || 'unknown');
                byResult[res] = (byResult[res] || 0) + 1;
                const stop = String((r as any)?.sweepStopReason || (r as any)?.error || '').trim() || 'none';
                byStopReason[stop] = (byStopReason[stop] || 0) + 1;
                const pct = (r as any)?.fillPct != null ? Number((r as any).fillPct) : NaN;
                if (Number.isFinite(pct)) { fillPctSum += pct; fillPctN += 1; }
                const lat = (r as any)?.sweepLatencyMs != null ? Number((r as any).sweepLatencyMs) : NaN;
                if (Number.isFinite(lat)) { latencySum += lat; latencyN += 1; }
            }
            const avgFillPct = fillPctN ? (fillPctSum / fillPctN) : 0;
            const avgLatencyMs = latencyN ? (latencySum / latencyN) : null;
            return { success: true, limit: Math.max(1, Math.floor(Number(limit) || 50)), count: Array.isArray(list) ? list.length : 0, byResult, byStopReason, avgFillPct, avgLatencyMs };
        }
    });

    fastify.post('/autotrade/paper/clear', {
        schema: {
            tags: ['跟單'],
            summary: 'Clear PaperTrade history',
        },
        handler: async (request) => {
            const body = (request as any)?.body || {};
            const keep = (body as any)?.keep;
            const r = autoTrader.trimPaperHistory(keep);
            return { success: true, ...r };
        }
    });

    fastify.get('/autotrade/pending', {
        schema: {
            tags: ['跟單'],
            summary: 'Get pending AutoTrade queue',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', default: 200 },
                }
            }
        },
        handler: async (request) => {
            const q = request.query as any;
            const limit = q?.limit != null ? Number(q.limit) : 200;
            return { success: true, pending: autoTrader.getPending(limit) };
        }
    });

    fastify.post('/autotrade/pending/clear', {
        schema: {
            tags: ['跟單'],
            summary: 'Clear pending AutoTrade queue',
        },
        handler: async (request) => {
            const body = (request as any)?.body || {};
            const keep = (body as any)?.keep;
            const r = autoTrader.trimPending(keep);
            return { success: true, ...r, pending: autoTrader.getPending(200) };
        }
    });

    fastify.post('/autotrade/pending/:id/execute', {
        schema: {
            tags: ['跟單'],
            summary: 'Execute one pending AutoTrade item',
            params: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                },
                required: ['id'],
            },
        },
        handler: async (request, reply) => {
            try {
                const { id } = request.params as any;
                const item = await autoTrader.executePending(String(id || ''));
                return { success: true, item };
            } catch (err: any) {
                return reply.status(400).send({ success: false, error: err?.message || String(err) });
            }
        }
    });

    fastify.get('/autotrade/history', {
        schema: {
            tags: ['跟單'],
            summary: 'Get AutoTrade history',
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', default: 200 },
                }
            }
        },
        handler: async (request) => {
            const q = request.query as any;
            const limit = q?.limit != null ? Number(q.limit) : 200;
            return { success: true, history: autoTrader.getHistory(limit) };
        }
    });
};
