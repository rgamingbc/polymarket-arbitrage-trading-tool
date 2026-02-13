export function buildOrderbookSnapshot(params: { book: any; fetchedAtMs: number; topN?: number }) {
    const book = params.book || {};
    const fetchedAtMs = Number(params.fetchedAtMs) || Date.now();
    const topN = Math.max(1, Math.min(200, Math.floor(Number(params.topN ?? 25))));

    const asksRaw = Array.isArray(book?.asks) ? book.asks : [];
    const bidsRaw = Array.isArray(book?.bids) ? book.bids : [];

    const normalize = (rows: any[]) => rows
        .map((r: any) => {
            const price = Number(r?.price);
            const size = Number(r?.size ?? r?.amount ?? r?.quantity);
            if (!Number.isFinite(price) || price <= 0) return null;
            if (!Number.isFinite(size) || size <= 0) return null;
            return { price, size };
        })
        .filter(Boolean) as Array<{ price: number; size: number }>;

    const asks = normalize(asksRaw).sort((a, b) => a.price - b.price);
    const bids = normalize(bidsRaw).sort((a, b) => b.price - a.price);

    const bestAsk = asks.length ? asks[0].price : null;
    const bestBid = bids.length ? bids[0].price : null;
    const spread = bestAsk != null && bestBid != null ? Math.max(0, bestAsk - bestBid) : null;

    const withCum = (rows: Array<{ price: number; size: number }>) => {
        let cumUsd = 0;
        const out: Array<{ price: number; size: number; cumUsd: number }> = [];
        for (const r of rows.slice(0, topN)) {
            cumUsd += r.price * r.size;
            out.push({ price: r.price, size: r.size, cumUsd });
        }
        return out;
    };

    return {
        fetchedAtMs,
        bestAsk,
        bestBid,
        spread,
        asksCount: asks.length,
        bidsCount: bids.length,
        asksTop: withCum(asks),
        bidsTop: withCum(bids),
    };
}

