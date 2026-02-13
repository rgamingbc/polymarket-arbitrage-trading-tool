import type { TradingClient } from '../../../dist/index.js';
import type { FollowActivitySuggestion } from './follow-activity.js';
import { runSweepBuyLive, simulateSweepBuy } from './sweep-buy.js';
import fs from 'node:fs';
import path from 'node:path';

export type AutoTradeMode = 'queue' | 'auto';
export type PaperFillRule = 'touch' | 'sweep';
export type ExecutionStyle = 'copy' | 'sweep';

export interface AutoTradeConfig {
    enabled: boolean;
    mode: AutoTradeMode;
    executionStyle: ExecutionStyle;
    allowConditionIds: string[];
    allowCategories: string[];
    denyConditionIds: string[];
    priceBufferCents: number;
    maxOrdersPerHour: number;
    paperTradeEnabled: boolean;
    paperFillRule: PaperFillRule;
    paperBookLevels: number;
    paperMinFillPct: number;
    sweepPriceCapCents: number;
    sweepMinTriggerCents: number;
    sweepMaxUsdcPerEvent: number;
    sweepMaxOrdersPerEvent: number;
    sweepMinIntervalMs: number;
}

export interface AutoTradeStatus {
    enabled: boolean;
    mode: AutoTradeMode;
    allowCount: number;
    allowCategoriesCount: number;
    denyCount: number;
    pendingCount: number;
    lastError: string | null;
    hasPrivateKey: boolean;
    paperTradeEnabled: boolean;
    paperTradeCount: number;
}

export interface PendingAutoTrade {
    id: string;
    createdAt: string;
    suggestion: FollowActivitySuggestion;
    tokenId: string;
    side: 'BUY';
    amountUsdc: number;
    limitPrice: number;
    executionStyle: ExecutionStyle;
    sweep?: { maxOrders: number; minIntervalMs: number; pollTimeoutMs: number } | null;
    status: 'pending' | 'executed' | 'failed' | 'skipped';
    orderId: string | null;
    error: string | null;
}

export interface AutoTradeHistoryItem {
    at: string;
    action: 'queued' | 'executed' | 'skipped' | 'failed' | 'config' | 'trim_pending' | 'trim_paper';
    id?: string;
    conditionId?: string;
    tokenId?: string;
    amountUsdc?: number;
    limitPrice?: number;
    orderId?: string | null;
    error?: string | null;
    mode?: AutoTradeMode;
    kept?: number;
    removed?: number;
}

export interface PaperTradeRecord {
    id: string;
    at: string;
    conditionId: string;
    tokenId: string;
    category: string;
    title: string | null;
    targetUsdc: number;
    limitPrice: number;
    fillUsdc: number;
    fillPct: number;
    avgFillPrice: number | null;
    bestAsk: number | null;
    bestAskSize: number | null;
    rule: PaperFillRule;
    levels: Array<{ price: number; size: number }>;
    sweepOrders: number | null;
    sweepAttemptedUsdc: number | null;
    sweepFilledUsdc: number | null;
    sweepFilledShares: number | null;
    sweepAvgFillPrice: number | null;
    sweepStopReason: string | null;
    sweepLatencyMs: number | null;
    result: 'simulated_filled' | 'simulated_partial' | 'simulated_not_filled' | 'simulated_error';
    error: string | null;
}

export interface PaperTradeStatus {
    enabled: boolean;
    rule: PaperFillRule;
    bookLevels: number;
    minFillPct: number;
    count: number;
    lastError: string | null;
}

type OrderbookLevel = { price: number; size: number };

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

const normalizeIdList = (arr: unknown): string[] => {
    const list = Array.isArray(arr) ? arr : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const x of list) {
        const s = String(x || '').trim();
        const k = s.toLowerCase();
        if (!s) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(s);
    }
    return out;
};

export class FollowAutoTrader {
    private config: AutoTradeConfig = {
        enabled: false,
        mode: 'queue',
        executionStyle: 'copy',
        allowConditionIds: [],
        allowCategories: [],
        denyConditionIds: [],
        priceBufferCents: 1,
        maxOrdersPerHour: 6,
        paperTradeEnabled: false,
        paperFillRule: 'sweep',
        paperBookLevels: 10,
        paperMinFillPct: 90,
        sweepPriceCapCents: 99.9,
        sweepMinTriggerCents: 99.0,
        sweepMaxUsdcPerEvent: 500,
        sweepMaxOrdersPerEvent: 6,
        sweepMinIntervalMs: 200,
    };
    private pending: PendingAutoTrade[] = [];
    private history: AutoTradeHistoryItem[] = [];
    private paperHistory: PaperTradeRecord[] = [];
    private lastError: string | null = null;
    private paperLastError: string | null = null;
    private handled: Map<string, { atMs: number; ttlMs: number }> = new Map();
    private executedAtMs: number[] = [];
    private paperHistoryPath: string | null = null;
    private paperHistoryPersistTimer: any = null;
    private paperHistoryPersistLastError: string | null = null;

    constructor(
        private getTradingClient: () => Promise<TradingClient>,
        private hasPrivateKey: boolean,
        private getOrderbook: (tokenId: string) => Promise<{ bids?: OrderbookLevel[]; asks?: OrderbookLevel[] }>,
        options?: { paperHistoryPath?: string }
    ) {
        const p = options?.paperHistoryPath != null ? String(options.paperHistoryPath).trim() : '';
        this.paperHistoryPath = p || null;
        this.loadPaperHistoryFromFile();
    }

    private loadPaperHistoryFromFile() {
        const p = this.paperHistoryPath;
        if (!p) return;
        try {
            if (!fs.existsSync(p)) return;
            const raw = fs.readFileSync(p, 'utf8');
            const parsed = JSON.parse(String(raw || '{}'));
            const list = Array.isArray(parsed?.paperHistory) ? parsed.paperHistory : (Array.isArray(parsed) ? parsed : []);
            const cleaned = (Array.isArray(list) ? list : []).filter((r: any) => {
                const stop = String(r?.sweepStopReason || '').toLowerCase();
                const err = String(r?.error || '').toLowerCase();
                return stop !== 'not_allowed' && err !== 'not_allowed';
            });
            this.paperHistory = cleaned.slice(0, 1000);
            this.paperLastError = null;
        } catch (e: any) {
            this.paperHistoryPersistLastError = e?.message || String(e);
        }
    }

    private schedulePersistPaperHistory() {
        const p = this.paperHistoryPath;
        if (!p) return;
        if (this.paperHistoryPersistTimer) return;
        this.paperHistoryPersistTimer = setTimeout(() => {
            this.paperHistoryPersistTimer = null;
            try {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                const tmp = `${p}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify({ paperHistory: this.paperHistory.slice(0, 1000) }));
                fs.renameSync(tmp, p);
                this.paperHistoryPersistLastError = null;
            } catch (e: any) {
                this.paperHistoryPersistLastError = e?.message || String(e);
            }
        }, 250);
    }

    getStatus(): AutoTradeStatus {
        return {
            enabled: !!this.config.enabled,
            mode: this.config.mode,
            allowCount: this.config.allowConditionIds.length,
            allowCategoriesCount: this.config.allowCategories.length,
            denyCount: this.config.denyConditionIds.length,
            pendingCount: this.pending.filter((p) => p.status === 'pending').length,
            lastError: this.lastError,
            hasPrivateKey: this.hasPrivateKey,
            paperTradeEnabled: !!this.config.paperTradeEnabled,
            paperTradeCount: this.paperHistory.length,
        };
    }

    getConfig(): AutoTradeConfig {
        return {
            ...this.config,
            allowConditionIds: [...this.config.allowConditionIds],
            allowCategories: [...this.config.allowCategories],
            denyConditionIds: [...this.config.denyConditionIds]
        };
    }

    getPending(limit = 200): PendingAutoTrade[] {
        const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
        return this.pending.slice(0, n);
    }

    getHistory(limit = 200): AutoTradeHistoryItem[] {
        const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
        return this.history.slice(0, n);
    }

    trimPending(keep = 50) {
        const n = Math.max(50, Math.min(1000, Math.floor(Number(keep) || 50)));
        const before = this.pending.length;
        this.pending = this.pending.slice(0, n);
        const after = this.pending.length;
        const removed = Math.max(0, before - after);
        this.history.unshift({ at: new Date().toISOString(), action: 'trim_pending', kept: after, removed });
        return { kept: after, removed };
    }

    clearPending() {
        return this.trimPending(50);
    }

    getPaperStatus(): PaperTradeStatus {
        return {
            enabled: !!this.config.paperTradeEnabled,
            rule: this.config.paperFillRule,
            bookLevels: this.config.paperBookLevels,
            minFillPct: this.config.paperMinFillPct,
            count: this.paperHistory.length,
            lastError: this.paperLastError,
        };
    }

    getPaperHistory(limit = 200) {
        const n = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
        return this.paperHistory.slice(0, n);
    }

    trimPaperHistory(keep = 50) {
        const n = Math.max(50, Math.min(1000, Math.floor(Number(keep) || 50)));
        const before = this.paperHistory.length;
        this.paperHistory = this.paperHistory.slice(0, n);
        const after = this.paperHistory.length;
        const removed = Math.max(0, before - after);
        this.paperLastError = null;
        this.history.unshift({ at: new Date().toISOString(), action: 'trim_paper', kept: after, removed });
        this.schedulePersistPaperHistory();
        return { kept: after, removed };
    }

    clearPaperHistory() {
        return this.trimPaperHistory(50);
    }

    updateConfig(next: Partial<AutoTradeConfig>) {
        const enabled = next.enabled != null ? !!next.enabled : this.config.enabled;
        const mode: AutoTradeMode = String(next.mode || this.config.mode) === 'auto' ? 'auto' : 'queue';
        const executionStyle: ExecutionStyle = String((next as any).executionStyle || this.config.executionStyle) === 'sweep' ? 'sweep' : 'copy';
        const allowConditionIds = next.allowConditionIds != null ? normalizeIdList(next.allowConditionIds) : this.config.allowConditionIds;
        const allowCategories = next.allowCategories != null ? normalizeIdList(next.allowCategories) : this.config.allowCategories;
        const denyConditionIds = next.denyConditionIds != null ? normalizeIdList(next.denyConditionIds) : this.config.denyConditionIds;
        const priceBufferCents = next.priceBufferCents != null ? clamp(Number(next.priceBufferCents) || 0, 0, 50) : this.config.priceBufferCents;
        const maxOrdersPerHour = next.maxOrdersPerHour != null ? clamp(Math.floor(Number(next.maxOrdersPerHour) || 0), 0, 1000) : this.config.maxOrdersPerHour;
        const paperTradeEnabled = next.paperTradeEnabled != null ? !!next.paperTradeEnabled : this.config.paperTradeEnabled;
        const paperFillRule: PaperFillRule = String(next.paperFillRule || this.config.paperFillRule) === 'touch' ? 'touch' : 'sweep';
        const paperBookLevels = next.paperBookLevels != null ? clamp(Math.floor(Number(next.paperBookLevels) || 0), 1, 50) : this.config.paperBookLevels;
        const paperMinFillPct = next.paperMinFillPct != null ? clamp(Number(next.paperMinFillPct) || 0, 0, 100) : this.config.paperMinFillPct;
        const sweepPriceCapCents = (next as any).sweepPriceCapCents != null ? clamp(Number((next as any).sweepPriceCapCents) || 0, 0.1, 99.9) : this.config.sweepPriceCapCents;
        const sweepMinTriggerCents = (next as any).sweepMinTriggerCents != null ? clamp(Number((next as any).sweepMinTriggerCents) || 0, 0, 99.9) : this.config.sweepMinTriggerCents;
        const sweepMaxUsdcPerEvent = (next as any).sweepMaxUsdcPerEvent != null ? clamp(Number((next as any).sweepMaxUsdcPerEvent) || 0, 0, 50_000) : this.config.sweepMaxUsdcPerEvent;
        const sweepMaxOrdersPerEvent = (next as any).sweepMaxOrdersPerEvent != null ? clamp(Math.floor(Number((next as any).sweepMaxOrdersPerEvent) || 0), 1, 200) : this.config.sweepMaxOrdersPerEvent;
        const sweepMinIntervalMs = (next as any).sweepMinIntervalMs != null ? clamp(Math.floor(Number((next as any).sweepMinIntervalMs) || 0), 0, 30_000) : this.config.sweepMinIntervalMs;

        if (enabled && !paperTradeEnabled && mode === 'auto' && !this.hasPrivateKey) {
            throw new Error('AutoTrade requires POLY_PRIVKEY (enable queue mode or set key)');
        }

        this.config = {
            enabled,
            mode,
            executionStyle,
            allowConditionIds,
            allowCategories,
            denyConditionIds,
            priceBufferCents,
            maxOrdersPerHour,
            paperTradeEnabled,
            paperFillRule,
            paperBookLevels,
            paperMinFillPct,
            sweepPriceCapCents,
            sweepMinTriggerCents,
            sweepMaxUsdcPerEvent,
            sweepMaxOrdersPerEvent,
            sweepMinIntervalMs,
        };
        this.history.unshift({ at: new Date().toISOString(), action: 'config', mode });
        this.lastError = null;
        this.paperLastError = null;
        return this.getStatus();
    }

    private canExecuteNow(nowMs: number) {
        const oneHourAgo = nowMs - 60 * 60_000;
        this.executedAtMs = this.executedAtMs.filter((t) => t >= oneHourAgo);
        if (this.config.maxOrdersPerHour <= 0) return false;
        return this.executedAtMs.length < this.config.maxOrdersPerHour;
    }

    private recordPaperSkip(input: {
        id: string;
        conditionId: string;
        tokenId: string;
        category: string;
        title: string | null;
        targetUsdc: number;
        limitPrice: number;
        rule: PaperFillRule;
        bestAsk: number | null;
        bestAskSize: number | null;
        levels: Array<{ price: number; size: number }>;
        stopReason: string;
        latencyMs: number | null;
        error: string | null;
    }) {
        this.paperHistory.unshift({
            id: input.id,
            at: new Date().toISOString(),
            conditionId: input.conditionId,
            tokenId: input.tokenId,
            category: input.category,
            title: input.title,
            targetUsdc: input.targetUsdc,
            limitPrice: input.limitPrice,
            fillUsdc: 0,
            fillPct: 0,
            avgFillPrice: null,
            bestAsk: input.bestAsk,
            bestAskSize: input.bestAskSize,
            rule: input.rule,
            levels: input.levels,
            sweepOrders: 0,
            sweepAttemptedUsdc: 0,
            sweepFilledUsdc: 0,
            sweepFilledShares: 0,
            sweepAvgFillPrice: null,
            sweepStopReason: input.stopReason,
            sweepLatencyMs: input.latencyMs,
            result: 'simulated_not_filled',
            error: input.error || input.stopReason,
        });
        this.paperHistory = this.paperHistory.slice(0, 1000);
        this.schedulePersistPaperHistory();
    }

    async applySuggestions(suggestions: FollowActivitySuggestion[]) {
        if (!this.config.enabled && !this.config.paperTradeEnabled) return;
        const list = Array.isArray(suggestions) ? suggestions : [];
        if (!list.length) return;

        const allow = new Set(this.config.allowConditionIds.map((x) => String(x || '').toLowerCase()).filter(Boolean));
        const allowCats = new Set(this.config.allowCategories.map((x) => String(x || '').toLowerCase()).filter(Boolean));
        const deny = new Set(this.config.denyConditionIds.map((x) => String(x || '').toLowerCase()).filter(Boolean));

        const nowMs = Date.now();
        for (const [k, v] of this.handled.entries()) {
            const atMs = Number(v?.atMs || 0);
            const ttlMs = Number(v?.ttlMs || 0);
            if (atMs <= 0 || ttlMs <= 0 || nowMs - atMs > ttlMs) this.handled.delete(k);
        }

        for (const s of list) {
            const id = String(s?.id || '');
            if (!id) continue;
            if (this.handled.has(id)) continue;

            const cid = String(s?.conditionId || '').trim();
            const cidKey = cid.toLowerCase();
            if (!cid) continue;
            const tokenId = String(s?.asset || '').trim();
            const leaderPrice = Number(s?.leaderPrice);
            const amountUsdcCopy = Number(s?.myUsdc);
            const title = s?.title != null ? String(s.title) : null;
            const catKey = String(s?.category || '').toLowerCase();
            const category = String(s?.category || 'other');
            const side = String(s?.side || '');

            if (deny.has(cidKey)) {
                this.history.unshift({ at: new Date().toISOString(), action: 'skipped', id, conditionId: cid, error: 'denied' });
                if (this.config.paperTradeEnabled) {
                    this.recordPaperSkip({
                        id,
                        conditionId: cid,
                        tokenId,
                        category,
                        title,
                        targetUsdc: 0,
                        limitPrice: Number.isFinite(leaderPrice) ? leaderPrice : 0,
                        rule: this.config.paperFillRule,
                        bestAsk: null,
                        bestAskSize: null,
                        levels: [],
                        stopReason: 'denied',
                        latencyMs: null,
                        error: 'denied',
                    });
                    this.handled.set(id, { atMs: nowMs, ttlMs: 60_000 });
                }
                continue;
            }
            const allowed = allow.has(cidKey) || (catKey && allowCats.has(catKey));
            if (!allowed) {
                this.history.unshift({ at: new Date().toISOString(), action: 'skipped', id, conditionId: cid, error: 'not_allowed' });
                this.handled.set(id, { atMs: nowMs, ttlMs: 30_000 });
                continue;
            }
            if (side !== 'BUY') {
                this.history.unshift({ at: new Date().toISOString(), action: 'skipped', id, conditionId: cid, error: 'side_not_supported' });
                if (this.config.paperTradeEnabled) {
                    this.recordPaperSkip({
                        id,
                        conditionId: cid,
                        tokenId,
                        category,
                        title,
                        targetUsdc: 0,
                        limitPrice: Number.isFinite(leaderPrice) ? leaderPrice : 0,
                        rule: this.config.paperFillRule,
                        bestAsk: null,
                        bestAskSize: null,
                        levels: [],
                        stopReason: 'side_not_supported',
                        latencyMs: null,
                        error: 'side_not_supported',
                    });
                    this.handled.set(id, { atMs: nowMs, ttlMs: 60_000 });
                }
                continue;
            }

            const style: ExecutionStyle = this.config.executionStyle;
            const sweepCap = clamp((Number(this.config.sweepPriceCapCents) || 0) / 100, 0.001, 0.999);
            const sweepTrigger = clamp((Number(this.config.sweepMinTriggerCents) || 0) / 100, 0, 0.999);
            const sweepBudget = Math.max(0, Number(this.config.sweepMaxUsdcPerEvent) || 0);
            const amountUsdc = style === 'sweep' && sweepBudget > 0 ? sweepBudget : amountUsdcCopy;
            const limitPrice = style === 'sweep'
                ? sweepCap
                : clamp(leaderPrice + (Number(this.config.priceBufferCents) || 0) / 100, 0.001, 0.999);

            if (!tokenId) {
                this.history.unshift({ at: new Date().toISOString(), action: 'skipped', id, conditionId: cid, error: 'missing_tokenId' });
                if (this.config.paperTradeEnabled) {
                    this.recordPaperSkip({
                        id,
                        conditionId: cid,
                        tokenId,
                        category,
                        title,
                        targetUsdc: 0,
                        limitPrice: Number.isFinite(limitPrice) ? limitPrice : 0,
                        rule: this.config.paperFillRule,
                        bestAsk: null,
                        bestAskSize: null,
                        levels: [],
                        stopReason: 'missing_tokenId',
                        latencyMs: null,
                        error: 'missing_tokenId',
                    });
                    this.handled.set(id, { atMs: nowMs, ttlMs: 30_000 });
                }
                continue;
            }
            if (!Number.isFinite(leaderPrice) || leaderPrice <= 0) {
                this.history.unshift({ at: new Date().toISOString(), action: 'skipped', id, conditionId: cid, error: 'bad_price' });
                if (this.config.paperTradeEnabled) {
                    this.recordPaperSkip({
                        id,
                        conditionId: cid,
                        tokenId,
                        category,
                        title,
                        targetUsdc: 0,
                        limitPrice: Number.isFinite(limitPrice) ? limitPrice : 0,
                        rule: this.config.paperFillRule,
                        bestAsk: null,
                        bestAskSize: null,
                        levels: [],
                        stopReason: 'bad_price',
                        latencyMs: null,
                        error: 'bad_price',
                    });
                    this.handled.set(id, { atMs: nowMs, ttlMs: 30_000 });
                }
                continue;
            }

            if (style === 'sweep' && sweepBudget <= 0) {
                this.history.unshift({ at: new Date().toISOString(), action: 'skipped', id, conditionId: cid, error: 'zero_budget' });
                if (this.config.paperTradeEnabled) {
                    this.recordPaperSkip({
                        id,
                        conditionId: cid,
                        tokenId,
                        category,
                        title,
                        targetUsdc: 0,
                        limitPrice,
                        rule: this.config.paperFillRule,
                        bestAsk: null,
                        bestAskSize: null,
                        levels: [],
                        stopReason: 'zero_budget',
                        latencyMs: null,
                        error: 'zero_budget',
                    });
                    this.handled.set(id, { atMs: nowMs, ttlMs: 60_000 });
                }
                continue;
            }
            if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
                this.history.unshift({ at: new Date().toISOString(), action: 'skipped', id, conditionId: cid, error: 'zero_size' });
                if (this.config.paperTradeEnabled) {
                    this.recordPaperSkip({
                        id,
                        conditionId: cid,
                        tokenId,
                        category,
                        title,
                        targetUsdc: 0,
                        limitPrice,
                        rule: this.config.paperFillRule,
                        bestAsk: null,
                        bestAskSize: null,
                        levels: [],
                        stopReason: 'zero_size',
                        latencyMs: null,
                        error: 'zero_size',
                    });
                    this.handled.set(id, { atMs: nowMs, ttlMs: 60_000 });
                }
                continue;
            }

            if (this.config.paperTradeEnabled) {
                await this.simulatePaperTrade({
                    id,
                    at: Number(s?.at),
                    conditionId: cid,
                    tokenId,
                    category,
                    title,
                    targetUsdc: amountUsdc,
                    limitPrice,
                    minTriggerPrice: style === 'sweep' ? sweepTrigger : null,
                });
                this.handled.set(id, { atMs: nowMs, ttlMs: 5 * 60_000 });
                continue;
            }

            const pending: PendingAutoTrade = {
                id,
                createdAt: new Date().toISOString(),
                suggestion: s,
                tokenId,
                side: 'BUY',
                amountUsdc,
                limitPrice,
                executionStyle: style,
                sweep: style === 'sweep' ? { maxOrders: Math.max(1, Math.floor(Number(this.config.sweepMaxOrdersPerEvent) || 1)), minIntervalMs: Math.max(0, Math.floor(Number(this.config.sweepMinIntervalMs) || 0)), pollTimeoutMs: 1500 } : null,
                status: 'pending',
                orderId: null,
                error: null,
            };

            if (this.config.mode === 'queue') {
                this.pending.unshift(pending);
                this.pending = this.pending.slice(0, 500);
                this.history.unshift({ at: new Date().toISOString(), action: 'queued', id, conditionId: cid, tokenId, amountUsdc, limitPrice });
                this.handled.set(id, { atMs: nowMs, ttlMs: 6 * 60 * 60_000 });
                continue;
            }

            if (!this.canExecuteNow(nowMs)) {
                pending.status = 'skipped';
                pending.error = 'rate_limited';
                this.pending.unshift(pending);
                this.pending = this.pending.slice(0, 500);
                this.history.unshift({ at: new Date().toISOString(), action: 'skipped', id, conditionId: cid, error: 'rate_limited' });
                this.handled.set(id, { atMs: nowMs, ttlMs: 15_000 });
                continue;
            }

            await this.executePendingInternal(pending);
            this.handled.set(id, { atMs: nowMs, ttlMs: 6 * 60 * 60_000 });
        }
    }

    private async simulatePaperTrade(input: {
        id: string;
        at: number;
        conditionId: string;
        tokenId: string;
        category: string;
        title: string | null;
        targetUsdc: number;
        limitPrice: number;
        minTriggerPrice: number | null;
    }) {
        const now = new Date().toISOString();
        const rule = this.config.paperFillRule;
        const levelsN = clamp(this.config.paperBookLevels, 1, 50);
        const minFillPct = clamp(this.config.paperMinFillPct, 0, 100);

        try {
            const t0 = Date.now();
            const book = await this.getOrderbook(input.tokenId);
            const roundtripMs = Date.now() - t0;
            const asksRaw = Array.isArray((book as any)?.asks) ? (book as any).asks : [];
            const asks: OrderbookLevel[] = asksRaw
                .map((x: any) => ({ price: Number(x?.price), size: Number(x?.size) }))
                .filter((x: any) => Number.isFinite(x.price) && x.price > 0 && Number.isFinite(x.size) && x.size > 0)
                .sort((a: any, b: any) => Number(a.price) - Number(b.price));

            const levels = asks.slice(0, levelsN).map((x) => ({ price: x.price, size: x.size }));
            const best = asks.length ? asks[0] : null;

            if (input.minTriggerPrice != null && best && Number.isFinite(Number(best.price)) && Number(best.price) + 1e-12 < Number(input.minTriggerPrice)) {
                this.paperHistory.unshift({
                    id: input.id,
                    at: now,
                    conditionId: input.conditionId,
                    tokenId: input.tokenId,
                    category: input.category,
                    title: input.title,
                    targetUsdc: input.targetUsdc,
                    limitPrice: input.limitPrice,
                    fillUsdc: 0,
                    fillPct: 0,
                    avgFillPrice: null,
                    bestAsk: best ? best.price : null,
                    bestAskSize: best ? best.size : null,
                    rule,
                    levels,
                    sweepOrders: 0,
                    sweepAttemptedUsdc: 0,
                    sweepFilledUsdc: 0,
                    sweepFilledShares: 0,
                    sweepAvgFillPrice: null,
                    sweepStopReason: 'below_trigger',
                    sweepLatencyMs: roundtripMs,
                    result: 'simulated_not_filled',
                    error: 'below_trigger',
                });
                this.paperHistory = this.paperHistory.slice(0, 1000);
                this.schedulePersistPaperHistory();
                this.paperLastError = null;
                return;
            }

            const sim = simulateSweepBuy({
                tokenId: input.tokenId,
                asks: asksRaw,
                priceCap: input.limitPrice,
                budgetUsd: input.targetUsdc,
                maxLevels: rule === 'touch' ? 1 : levelsN,
            });
            const fillUsdc = Number(sim.summary.totalFilledUsd) || 0;
            const fillPct = input.targetUsdc > 0 ? clamp((fillUsdc / input.targetUsdc) * 100, 0, 100) : 0;
            const avgFillPrice = sim.summary.avgFillPrice != null ? Number(sim.summary.avgFillPrice) : null;

            const result: PaperTradeRecord['result'] =
                fillPct >= minFillPct ? 'simulated_filled' : fillPct > 0 ? 'simulated_partial' : 'simulated_not_filled';

            this.paperHistory.unshift({
                id: input.id,
                at: now,
                conditionId: input.conditionId,
                tokenId: input.tokenId,
                category: input.category,
                title: input.title,
                targetUsdc: input.targetUsdc,
                limitPrice: input.limitPrice,
                fillUsdc,
                fillPct,
                avgFillPrice,
                bestAsk: best ? best.price : null,
                bestAskSize: best ? best.size : null,
                rule,
                levels,
                sweepOrders: sim.summary.totalOrders ?? null,
                sweepAttemptedUsdc: sim.summary.totalAttemptedUsd ?? null,
                sweepFilledUsdc: sim.summary.totalFilledUsd ?? null,
                sweepFilledShares: sim.summary.totalFilledShares ?? null,
                sweepAvgFillPrice: sim.summary.avgFillPrice ?? null,
                sweepStopReason: sim.summary.stopReason ?? null,
                sweepLatencyMs: roundtripMs,
                result,
                error: null,
            });
            this.paperHistory = this.paperHistory.slice(0, 1000);
            this.schedulePersistPaperHistory();
            this.paperLastError = null;
        } catch (e: any) {
            const msg = e?.message ? String(e.message) : String(e);
            this.paperLastError = msg;
            this.paperHistory.unshift({
                id: input.id,
                at: now,
                conditionId: input.conditionId,
                tokenId: input.tokenId,
                category: input.category,
                title: input.title,
                targetUsdc: input.targetUsdc,
                limitPrice: input.limitPrice,
                fillUsdc: 0,
                fillPct: 0,
                avgFillPrice: null,
                bestAsk: null,
                bestAskSize: null,
                rule,
                levels: [],
                sweepOrders: null,
                sweepAttemptedUsdc: null,
                sweepFilledUsdc: null,
                sweepFilledShares: null,
                sweepAvgFillPrice: null,
                sweepStopReason: null,
                sweepLatencyMs: null,
                result: 'simulated_error',
                error: msg,
            });
            this.paperHistory = this.paperHistory.slice(0, 1000);
            this.schedulePersistPaperHistory();
        }
    }

    async executePending(id: string) {
        const key = String(id || '').trim();
        const item = this.pending.find((p) => String(p.id) === key);
        if (!item) throw new Error('Pending item not found');
        if (item.status !== 'pending') return item;
        await this.executePendingInternal(item);
        return item;
    }

    private async executePendingInternal(item: PendingAutoTrade) {
        if (!this.hasPrivateKey) {
            item.status = 'failed';
            item.error = 'missing_private_key';
            this.history.unshift({ at: new Date().toISOString(), action: 'failed', id: item.id, conditionId: item.suggestion.conditionId, error: item.error });
            return;
        }
        try {
            const client: any = await this.getTradingClient();
            if (item.executionStyle === 'sweep') {
                const sweep = item.sweep || { maxOrders: 1, minIntervalMs: 0, pollTimeoutMs: 1200 };
                const r = await runSweepBuyLive({
                    tokenId: item.tokenId,
                    priceCap: item.limitPrice,
                    budgetUsd: item.amountUsdc,
                    maxOrders: Math.max(1, Math.floor(Number(sweep.maxOrders) || 1)),
                    minIntervalMs: Math.max(0, Math.floor(Number(sweep.minIntervalMs) || 0)),
                    fetchAsks: async () => {
                        const book: any = await this.getOrderbook(item.tokenId);
                        return Array.isArray(book?.asks) ? book.asks : [];
                    },
                    placeOrder: async ({ amountUsd, priceCap }) => {
                        const res = await client.createMarketOrder({
                            tokenId: item.tokenId,
                            side: 'BUY',
                            amount: amountUsd,
                            price: priceCap,
                            orderType: 'FAK',
                        } as any);
                        return { success: res?.success === true, orderId: res?.orderId ?? null, errorMsg: res?.errorMsg ?? null };
                    },
                    getOrder: async (orderId) => {
                        if (typeof client.getOrder === 'function') {
                            const o = await client.getOrder(String(orderId));
                            return { status: o?.status ?? null, filledSize: o?.filledSize ?? null, price: o?.price ?? null };
                        }
                        return { status: null, filledSize: null, price: null };
                    },
                    pollTimeoutMs: Math.max(0, Math.floor(Number(sweep.pollTimeoutMs) || 0)),
                    pollIntervalMs: 150,
                    maxLevels: 200,
                });

                const first = Array.isArray(r.orders) && r.orders.length ? r.orders[0] : null;
                item.orderId = first?.orderId != null ? String(first.orderId) : null;
                item.status = r.ok === true ? 'executed' : 'failed';
                item.error = r.ok === true ? null : (r.summary?.stopReason || first?.errorMsg || 'order_failed');
                if (item.status === 'executed') {
                    const okOrders = (Array.isArray(r.orders) ? r.orders : []).filter((o) => o && o.success === true).length;
                    for (let i = 0; i < Math.max(1, okOrders); i += 1) this.executedAtMs.push(Date.now());
                }
                this.history.unshift({
                    at: new Date().toISOString(),
                    action: item.status === 'executed' ? 'executed' : 'failed',
                    id: item.id,
                    conditionId: item.suggestion.conditionId,
                    tokenId: item.tokenId,
                    amountUsdc: r.summary?.totalAttemptedUsd ?? item.amountUsdc,
                    limitPrice: item.limitPrice,
                    orderId: item.orderId,
                    error: item.error,
                });
                this.lastError = null;
                return;
            }

            const res = await client.createMarketOrder({
                tokenId: item.tokenId,
                side: 'BUY',
                amount: item.amountUsdc,
                price: item.limitPrice,
                orderType: 'FAK',
            } as any);
            const orderId = res?.orderId != null ? String(res.orderId) : null;
            item.orderId = orderId;
            item.status = res?.success === true ? 'executed' : 'failed';
            item.error = res?.success === true ? null : (res?.errorMsg != null ? String(res.errorMsg) : 'order_failed');
            if (item.status === 'executed') this.executedAtMs.push(Date.now());
            this.history.unshift({
                at: new Date().toISOString(),
                action: item.status === 'executed' ? 'executed' : 'failed',
                id: item.id,
                conditionId: item.suggestion.conditionId,
                tokenId: item.tokenId,
                amountUsdc: item.amountUsdc,
                limitPrice: item.limitPrice,
                orderId,
                error: item.error,
            });
            this.lastError = null;
        } catch (e: any) {
            const msg = e?.message ? String(e.message) : String(e);
            item.status = 'failed';
            item.error = msg;
            this.lastError = msg;
            this.history.unshift({ at: new Date().toISOString(), action: 'failed', id: item.id, conditionId: item.suggestion.conditionId, error: msg });
        }
    }
}
