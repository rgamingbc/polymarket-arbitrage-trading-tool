import assert from 'node:assert/strict';
import { GroupArbitrageScanner } from '../services/group-arbitrage.js';

const main = async () => {
    const scanner = new GroupArbitrageScanner(undefined);

    (scanner as any).updateCrypto15mHedgeConfig({
        amountUsd: 1,
        entryRemainingMaxSec: 900,
        entryRemainingMinSec: 660,
        entryCheapMinCents: 7,
        entryCheapMaxCents: 14,
        targetProfitCents: 9,
        bufferCents: 1,
        minDepthPct: 0,
        hedgeIgnoreSpread: true,
        minSecToHedge: 0,
        profitDecayEnabled: false,
    });

    const entryTokenId = 'token_entry';
    const hedgeTokenId = 'token_hedge';
    const conditionId = 'cond_smoke';

    (scanner as any).getCrypto15mCandidates = async () => ({
        candidates: [
            {
                symbol: 'BTC',
                conditionId,
                slug: 'btc-updown-15m-smoke',
                title: 'BTC Up or Down (smoke)',
                endDate: new Date(Date.now() + 800_000).toISOString(),
                secondsToExpire: 800,
                tokenIds: [entryTokenId, hedgeTokenId],
                outcomes: ['Up', 'Down'],
                prices: [0.1, 0.9],
                reason: null,
            }
        ]
    });

    (scanner as any).crypto15mBooksSnapshot = {
        atMs: Date.now(),
        lastError: null,
        byTokenId: {
            [entryTokenId]: { bestBid: 0.09, bestAsk: 0.1, asksCount: 1 },
            [hedgeTokenId]: { bestBid: 0.78, bestAsk: 0.79, asksCount: 1 },
        },
    };
    (scanner as any).crypto15mMarketSnapshot = {
        atMs: Date.now(),
        lastError: null,
        markets: [{}],
    };

    (scanner as any).fetchClobBooks = async (tokenIds: string[]) => {
        const out: any[] = [];
        for (const t of tokenIds) {
            if (t === entryTokenId) {
                out.push({
                    asset_id: entryTokenId,
                    asks: [{ price: 0.1, size: 200 }],
                    bids: [{ price: 0.09, size: 200 }],
                });
            } else if (t === hedgeTokenId) {
                out.push({
                    asset_id: hedgeTokenId,
                    asks: [{ price: 0.79, size: 200 }],
                    bids: [{ price: 0.78, size: 200 }],
                });
            }
        }
        return out;
    };

    const res = await (scanner as any).getCrypto15mHedgeSignals();
    const opp = Array.isArray(res?.opportunities) ? res.opportunities : [];
    assert.equal(opp.length, 1, `expected exactly 1 opportunity, got ${opp.length}`);
    const row = opp[0] || {};

    assert.equal(row.symbol, 'BTC');
    assert.equal(row.entryEligible, true, `entryEligible should be true, got ${String(row.entryEligible)} (reason=${row.entryReason})`);
    assert.equal(row.secondEligibleNow, true, `secondEligibleNow should be true, got ${String(row.secondEligibleNow)} (reason=${row.secondReason})`);

    console.log('OK: crypto15m-hedge smoke');
    console.log({
        symbol: row.symbol,
        sec: row.secondsToExpire,
        entryBestAskCents: row.entryBestAsk != null ? Number(row.entryBestAsk) * 100 : null,
        hedgeBestAskCents: row.hedgeBestAsk != null ? Number(row.hedgeBestAsk) * 100 : null,
        effectiveProfitCents: row.effectiveProfitCents,
        bufferCents: (scanner as any).crypto15mHedgeAutoConfig?.bufferCents,
        p2MaxCents: row.p2Max != null ? Number(row.p2Max) * 100 : null,
        estEntryShares: row.estEntryShares,
        tradableShares: row.tradableShares,
    });
    process.exit(0);
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
