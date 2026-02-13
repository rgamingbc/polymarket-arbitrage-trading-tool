import assert from 'node:assert/strict';

export type FollowActivityType = 'TRADE' | 'SPLIT' | 'MERGE' | 'REDEEM' | 'CONVERSION';
export type FollowActivitySide = 'BUY' | 'SELL';

export type FollowActivityQueryMode = 'user' | 'proxyWallet' | 'auto';

export interface FollowActivityConfig {
    address: string;
    pollMs: number;
    limit: number;
    queryMode: FollowActivityQueryMode;
    types: FollowActivityType[];
    sides: FollowActivitySide[];
    includeKeywords: string[];
    excludeKeywords: string[];
    ratio: number;
    maxUsdcPerOrder: number;
    maxUsdcPerDay: number;
}

export interface FollowActivityEvent {
    type: FollowActivityType;
    side: FollowActivitySide;
    size: number;
    price: number;
    usdcSize?: number;
    asset: string;
    conditionId: string;
    outcome: string;
    timestamp: number;
    transactionHash: string;
    title?: string;
    slug?: string;
    name?: string;
}

export interface FollowActivitySuggestion {
    id: string;
    at: number;
    type: FollowActivityType;
    side: FollowActivitySide;
    conditionId: string;
    asset: string;
    outcome: string;
    title: string | null;
    slug: string | null;
    category: string;
    leaderUsdc: number;
    leaderPrice: number;
    myUsdc: number;
    cappedByOrder: boolean;
    cappedByDay: boolean;
}

export interface FollowActivityStatus {
    running: boolean;
    startedAt: string | null;
    lastPollAt: string | null;
    lastError: string | null;
    failCount: number;
    nextDelayMs: number;
    config: FollowActivityConfig | null;
    counters: {
        polls: number;
        fetched: number;
        newEvents: number;
        suggestions: number;
        deduped: number;
    };
}

const isHexAddress = (s: string) => /^0x[a-fA-F0-9]{40}$/.test(String(s || '').trim());

export const normalizeFollowActivityConfig = (input: Partial<FollowActivityConfig> & { address: string }): FollowActivityConfig => {
    const address = String(input.address || '').trim();
    assert.ok(isHexAddress(address), 'Invalid address (expected 0x + 40 hex chars)');
    const pollMs = Math.max(250, Math.min(120_000, Math.floor(Number(input.pollMs ?? 2_000))));
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit ?? 200))));
    const queryModeRaw = String(input.queryMode ?? 'auto').toLowerCase();
    const queryMode: FollowActivityQueryMode = queryModeRaw === 'user' ? 'user' : queryModeRaw === 'proxywallet' ? 'proxyWallet' : 'auto';
    const typesInput = Array.isArray(input.types) ? input.types : (['TRADE'] as FollowActivityType[]);
    const types = Array.from(new Set(typesInput.map((t) => String(t || '').toUpperCase()).filter(Boolean))) as FollowActivityType[];
    const sidesInput = Array.isArray(input.sides) ? input.sides : (['BUY'] as FollowActivitySide[]);
    const sides = Array.from(new Set(sidesInput.map((t) => String(t || '').toUpperCase()).filter(Boolean))) as FollowActivitySide[];
    const includeKeywords = (Array.isArray(input.includeKeywords) ? input.includeKeywords : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean);
    const excludeKeywords = (Array.isArray(input.excludeKeywords) ? input.excludeKeywords : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean);
    const ratio = Math.max(0, Math.min(1, Number(input.ratio ?? 0.02)));
    const maxUsdcPerOrder = Math.max(0, Math.min(100_000, Number(input.maxUsdcPerOrder ?? 50)));
    const maxUsdcPerDay = Math.max(0, Math.min(10_000_000, Number(input.maxUsdcPerDay ?? 500)));
    return {
        address,
        pollMs,
        limit,
        queryMode,
        types: types.length ? types : (['TRADE'] as FollowActivityType[]),
        sides: sides.length ? sides : (['BUY'] as FollowActivitySide[]),
        includeKeywords,
        excludeKeywords,
        ratio,
        maxUsdcPerOrder,
        maxUsdcPerDay,
    };
};

const inferCategory = (evt: FollowActivityEvent): string => {
    const t = `${evt.slug || ''} ${evt.title || ''}`.toLowerCase();
    if (/(btc|eth|sol|xrp|crypto|up or down|updown)/.test(t)) return 'crypto';
    if (/(election|politic|president|senate|house)/.test(t)) return 'politics';
    if (/(sports|nba|wnba|nfl|mlb|nhl|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|mma|f1|formula|ncaab|ncaa|college basketball)/.test(t)) return 'sports';
    if (/(^|[\s(])(vs\.?|@)([\s)]|$)/.test(t)) return 'sports';
    return 'other';
};

const matchesKeywords = (evt: FollowActivityEvent, includeKeywords: string[], excludeKeywords: string[]) => {
    const hay = `${evt.slug || ''} ${evt.title || ''} ${evt.outcome || ''}`.toLowerCase();
    for (const x of excludeKeywords) {
        const k = String(x || '').trim().toLowerCase();
        if (!k) continue;
        if (hay.includes(k)) return false;
    }
    if (includeKeywords.length) {
        for (const x of includeKeywords) {
            const k = String(x || '').trim().toLowerCase();
            if (!k) continue;
            if (hay.includes(k)) return true;
        }
        return false;
    }
    return true;
};

export const buildFollowActivitySuggestions = (
    events: FollowActivityEvent[],
    config: FollowActivityConfig,
    spentTodayUsdc: number
): FollowActivitySuggestion[] => {
    const out: FollowActivitySuggestion[] = [];
    const types = new Set(config.types.map((x) => String(x || '').toUpperCase()));
    const sides = new Set(config.sides.map((x) => String(x || '').toUpperCase()));
    let spent = Math.max(0, Number.isFinite(spentTodayUsdc) ? spentTodayUsdc : 0);

    for (const evt of events) {
        if (!evt) continue;
        const t = String(evt.type || '').toUpperCase();
        const s = String(evt.side || '').toUpperCase();
        if (types.size && !types.has(t)) continue;
        if (sides.size && !sides.has(s)) continue;
        if (!matchesKeywords(evt, config.includeKeywords, config.excludeKeywords)) continue;

        const leaderUsdc = Number(evt.usdcSize != null ? evt.usdcSize : (Number(evt.size) * Number(evt.price)));
        const leaderPrice = Number(evt.price);
        if (!Number.isFinite(leaderUsdc) || leaderUsdc <= 0) continue;
        if (!Number.isFinite(leaderPrice) || leaderPrice <= 0) continue;

        const rawMyUsdc = leaderUsdc * Number(config.ratio);
        if (!Number.isFinite(rawMyUsdc) || rawMyUsdc <= 0) continue;

        const cappedOrder = config.maxUsdcPerOrder > 0 ? Math.min(rawMyUsdc, config.maxUsdcPerOrder) : rawMyUsdc;
        const remainingDay = config.maxUsdcPerDay > 0 ? Math.max(0, config.maxUsdcPerDay - spent) : Infinity;
        const cappedDay = Number.isFinite(remainingDay) ? Math.min(cappedOrder, remainingDay) : cappedOrder;
        const myUsdc = Number.isFinite(cappedDay) ? Math.max(0, cappedDay) : 0;

        out.push({
            id: `${evt.transactionHash}:${evt.conditionId}:${evt.asset}:${evt.side}:${evt.size}:${evt.price}`,
            at: evt.timestamp,
            type: evt.type,
            side: evt.side,
            conditionId: evt.conditionId,
            asset: evt.asset,
            outcome: evt.outcome,
            title: evt.title ?? null,
            slug: evt.slug ?? null,
            category: inferCategory(evt),
            leaderUsdc,
            leaderPrice,
            myUsdc,
            cappedByOrder: config.maxUsdcPerOrder > 0 && myUsdc + 1e-9 < rawMyUsdc,
            cappedByDay: config.maxUsdcPerDay > 0 && myUsdc + 1e-9 < cappedOrder,
        });

        spent += myUsdc;
    }

    return out;
};

export class FollowActivityRunner {
    private timer: any = null;
    private config: FollowActivityConfig | null = null;
    private running = false;
    private startedAt: string | null = null;
    private lastPollAt: string | null = null;
    private lastError: string | null = null;
    private tickInFlight = false;
    private failCount = 0;
    private nextDelayMs = 0;
    private dedupe: Map<string, number> = new Map();
    private recentEvents: FollowActivityEvent[] = [];
    private recentSuggestions: FollowActivitySuggestion[] = [];
    private counters = { polls: 0, fetched: 0, newEvents: 0, suggestions: 0, deduped: 0 };
    private spentDayKey: string | null = null;
    private spentTodayUsdc = 0;
    private basePollMs = 2000;
    private readonly failThreshold = 3;
    private readonly maxBackoffMs = 10_000;
    private readonly retryPerTick = 2;

    constructor(
        private fetchActivity: (address: string, limit: number, queryMode: FollowActivityQueryMode) => Promise<FollowActivityEvent[]>,
        private options?: {
            onNewSuggestions?: (suggestions: FollowActivitySuggestion[]) => Promise<void> | void;
        }
    ) {}

    getStatus(): FollowActivityStatus {
        return {
            running: this.running,
            startedAt: this.startedAt,
            lastPollAt: this.lastPollAt,
            lastError: this.lastError,
            failCount: this.failCount,
            nextDelayMs: this.nextDelayMs,
            config: this.config,
            counters: { ...this.counters },
        };
    }

    getEvents(limit = 200) {
        const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
        return this.recentEvents.slice(0, n);
    }

    getSuggestions(limit = 200) {
        const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
        return this.recentSuggestions.slice(0, n);
    }

    getEventsBefore(beforeTs: number | null, limit = 200) {
        const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
        const bt = beforeTs != null && Number.isFinite(Number(beforeTs)) ? Number(beforeTs) : null;
        const list = this.recentEvents;
        if (bt == null) return list.slice(0, n);
        return list.filter((e) => Number(e?.timestamp || 0) < bt).slice(0, n);
    }

    getSuggestionsBefore(beforeAt: number | null, limit = 200) {
        const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
        const bt = beforeAt != null && Number.isFinite(Number(beforeAt)) ? Number(beforeAt) : null;
        const list = this.recentSuggestions;
        if (bt == null) return list.slice(0, n);
        return list.filter((s) => Number(s?.at || 0) < bt).slice(0, n);
    }

    start(next: FollowActivityConfig) {
        this.stop();
        this.config = next;
        this.running = true;
        this.startedAt = new Date().toISOString();
        this.lastError = null;
        this.lastPollAt = null;
        this.counters = { polls: 0, fetched: 0, newEvents: 0, suggestions: 0, deduped: 0 };
        this.tickInFlight = false;
        this.failCount = 0;
        this.basePollMs = Math.max(250, Math.min(120_000, Math.floor(Number(next.pollMs) || 2000)));
        this.nextDelayMs = this.basePollMs;
        this.scheduleNext(0);
        return this.getStatus();
    }

    stop() {
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.tickInFlight = false;
        this.nextDelayMs = 0;
        return this.getStatus();
    }

    private scheduleNext(delayMs: number) {
        if (!this.running) return;
        if (this.timer) clearTimeout(this.timer);
        const d = Math.max(0, Math.floor(Number(delayMs) || 0));
        this.nextDelayMs = d;
        this.timer = setTimeout(() => {
            this.tick().finally(() => {
                const nextDelay = this.computeNextDelayMs();
                this.scheduleNext(nextDelay);
            });
        }, d);
    }

    private computeNextDelayMs() {
        const base = this.basePollMs;
        if (this.failCount >= this.failThreshold) {
            const exp = this.failCount - (this.failThreshold - 1);
            const backoff = base * Math.pow(2, exp);
            return Math.min(this.maxBackoffMs, Math.max(base, Math.floor(backoff)));
        }
        return base;
    }

    private async sleep(ms: number) {
        const d = Math.max(0, Math.floor(Number(ms) || 0));
        if (!d) return;
        await new Promise((r) => setTimeout(r, d));
    }

    private rotateDayKey(now = Date.now()) {
        const d = new Date(now);
        const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        if (this.spentDayKey !== k) {
            this.spentDayKey = k;
            this.spentTodayUsdc = 0;
        }
    }

    private async tick() {
        if (!this.running || !this.config) return;
        if (this.tickInFlight) return;
        this.tickInFlight = true;
        const cfg = this.config;
        this.rotateDayKey();
        this.counters.polls += 1;
        this.lastPollAt = new Date().toISOString();

        try {
            let list: FollowActivityEvent[] = [];
            let lastErr: any = null;
            for (let attempt = 1; attempt <= this.retryPerTick; attempt++) {
                try {
                    list = await this.fetchActivity(cfg.address, cfg.limit, cfg.queryMode);
                    lastErr = null;
                    break;
                } catch (e: any) {
                    lastErr = e;
                    if (attempt < this.retryPerTick) {
                        await this.sleep(500);
                    }
                }
            }
            if (lastErr) throw lastErr;
            const fetched = Array.isArray(list) ? list : [];
            this.counters.fetched += fetched.length;

            const fresh: FollowActivityEvent[] = [];
            for (const evt of fetched) {
                const key = `${evt.transactionHash}:${evt.conditionId}:${evt.asset}:${evt.side}:${evt.size}:${evt.price}:${evt.type}`;
                const seenAt = this.dedupe.get(key);
                if (seenAt != null) { this.counters.deduped += 1; continue; }
                this.dedupe.set(key, Date.now());
                fresh.push(evt);
            }

            const nowMs = Date.now();
            for (const [k, v] of this.dedupe.entries()) {
                if (nowMs - Number(v || 0) > 24 * 60 * 60_000) this.dedupe.delete(k);
            }

            this.counters.newEvents += fresh.length;
            const suggestions = buildFollowActivitySuggestions(fresh, cfg, this.spentTodayUsdc);
            const spent = suggestions.reduce((sum, s) => sum + (Number(s.myUsdc) || 0), 0);
            if (spent > 0) this.spentTodayUsdc += spent;
            this.counters.suggestions += suggestions.length;
            if (suggestions.length && this.options?.onNewSuggestions) {
                try {
                    await this.options.onNewSuggestions(suggestions);
                } catch {
                }
            }

            if (fetched.length) {
                const sorted = fetched.slice().sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
                this.recentEvents = sorted.slice(0, 300);
            }
            if (suggestions.length) {
                const merged = [...suggestions, ...this.recentSuggestions];
                const uniq = new Map<string, FollowActivitySuggestion>();
                for (const s of merged) {
                    const id = String(s.id || '');
                    if (!id) continue;
                    if (!uniq.has(id)) uniq.set(id, s);
                }
                this.recentSuggestions = Array.from(uniq.values()).sort((a, b) => Number(b.at) - Number(a.at)).slice(0, 300);
            }

            this.lastError = null;
            this.failCount = 0;
        } catch (e: any) {
            this.lastError = e?.message ? String(e.message) : String(e);
            this.failCount += 1;
        } finally {
            this.tickInFlight = false;
        }
    }
}
