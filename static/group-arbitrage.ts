import { PolymarketSDK, RateLimiter, ApiType, PolymarketError, ErrorCode, withRetry } from '../../../dist/index.js';
import { TradingClientOverride as TradingClient } from '../clients/trading-client-override.js';
import { ethers } from 'ethers';

export interface GroupArbOpportunity {
    marketId: string;
    gammaId: string; // Store Gamma ID explicitly for links
    question: string;
    slug: string;
    outcomes: string[];
    tokenIds: string[];
    prices: number[];
    yesPrice: number;
    noPrice: number;
    totalCost: number;
    profit: number;
    profitPercent: number;
    liquidity: number;
    bidSum: number;
    endDate: string; // Added End Date for frontend visibility
    isWeather: boolean; // Flag to highlight weather markets
    ratioScore: number; // 0.0 to 1.0 (1.0 = perfect 50/50 split)
    image?: string; // Market icon URL
    volume24hr?: number;
}

interface MonitoredTrade {
    marketId: string;
    entryTime: number;
    entryPrice: number; // Avg cost per set
    peakPrice: number; // Track highest price for trailing stop
    tokenIds: string[];
    status: 'active' | 'closed';
}

export class GroupArbitrageScanner {
    private sdk: PolymarketSDK;
    private tradingClient: TradingClient;
    public latestResults: GroupArbOpportunity[] = [];
    public latestLogs: string[] = [];
    public orderHistory: any[] = []; // In-memory order history
    private monitoredTrades: Map<string, MonitoredTrade> = new Map(); // Track active trades for cut-loss
    private isRunning = false;
    private hasValidKey = false;

    constructor(privateKey?: string) {
        this.sdk = new PolymarketSDK({
            privateKey,
        } as any);

        this.hasValidKey = !!privateKey && privateKey.length > 50; // Simple check
        const effectiveKey = this.hasValidKey ? privateKey! : '0x0000000000000000000000000000000000000000000000000000000000000001';

        // Initialize Trading Client manually since SDK doesn't expose it publically
        const rateLimiter = new RateLimiter(); 
        
        // Check for Proxy Address in env
        const proxyAddress = process.env.POLY_PROXY_ADDRESS;
        if (proxyAddress) {
            console.log(`ℹ️ Using Proxy Address for Trading: ${proxyAddress}`);
        }

        this.tradingClient = new TradingClient(rateLimiter, {
            privateKey: effectiveKey,
            chainId: 137,
            proxyAddress: proxyAddress
        });
        
        // Initialize async
        this.tradingClient.initialize().catch(e => console.error('Failed to init trading client:', e));
        
        // Start monitoring loop for cut-loss/trailing stop
        this.startMonitoring();
    }

    // Start background scanning loop
    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log('🚀 Starting Background Arbitrage Scanner...');
        
        // Run forever
        const runLoop = async () => {
            while (this.isRunning) {
                try {
                    const result = await this.scanInternal();
                    this.latestResults = result.opportunities;
                    this.latestLogs = result.logs;
                    console.log(`✅ Background Scan Complete: Found ${result.opportunities.length} opportunities`);
                    
                    // Wait 30 seconds before next scan to be nice to API
                    await new Promise(r => setTimeout(r, 30000));
                } catch (e) {
                    console.error('Scan cycle failed:', e);
                    await new Promise(r => setTimeout(r, 10000));
                }
            }
        };
        runLoop(); // Don't await, let it run in background
    }

    async scanInternal(minLiquidity = 10, limit = 50): Promise<{ opportunities: GroupArbOpportunity[], logs: string[] }> {
        const logs: string[] = [];
        const log = (msg: string) => {
            console.log(msg);
            logs.push(msg);
        };

        log('🔍 Scanning top 2000 markets (Parallel Fetch + Weather Focus)...');
        
        let allMarkets: any[] = [];
        
        // Fetch 2000 markets in PARALLEL (20 batches of 100)
        // Gamma API handles rate limits, but we batch them slightly to be safe
        const offsets = Array.from({ length: 20 }, (_, i) => i * 100); 
        
        // Split into 4 chunks of 5 requests to avoid overwhelming
        const parallelChunks = [];
        for (let i = 0; i < offsets.length; i += 5) {
            parallelChunks.push(offsets.slice(i, i + 5));
        }

        for (const chunk of parallelChunks) {
            const promises = chunk.map(offset => 
                withRetry(() => this.sdk.gammaApi.getMarkets({
                    closed: false,
                    active: true,
                    limit: 100,
                    offset: offset,
                    order: 'endDate', 
                    ascending: true
                }), { maxRetries: 3 })
                .catch(e => {
                    log(`Error fetching offset ${offset}: ${e.message}`);
                    return [];
                })
            );

            const results = await Promise.all(promises);
            results.forEach(markets => allMarkets = allMarkets.concat(markets));
            log(`   Fetched batch (Total so far: ${allMarkets.length})`);
        }
        
        log(`Total markets fetched: ${allMarkets.length}`);

        let weatherCount = 0;
        let timeSkippedCount = 0;

        const multiOutcomeMarkets = allMarkets.filter((m: any) => {
            const q = m.question.toLowerCase();
            
            // 1. Strict Weather Filtering
            const isWeather = q.includes('temperature') || q.includes('weather') || q.includes('rain') || q.includes('snow') || q.includes('degree') || q.includes('°');
            if (!isWeather) return false;

            // 2. Filter out Crypto (Bitcoin, Ethereum, Solana, etc.) just in case
            if (q.includes('bitcoin') || q.includes('ethereum') || q.includes('solana') || q.includes('xrp') || q.includes('crypto')) {
                return false;
            }

            if (!m.outcomes) return false;
            let outcomeList = m.outcomes;
            if (typeof m.outcomes === 'string') {
                try { outcomeList = JSON.parse(m.outcomes); } catch { return false; }
            }
            if (!Array.isArray(outcomeList) || outcomeList.length < 2) return false;

            weatherCount++;
            return true;
        });

        log(`Found ${weatherCount} potential weather markets. Processing details...`);

        const opportunities: GroupArbOpportunity[] = [];
        const chunkSize = 10; 
        const marketsToProcess = multiOutcomeMarkets; 

        for (let i = 0; i < marketsToProcess.length; i += chunkSize) {
            const batch = marketsToProcess.slice(i, i + chunkSize);
            
            await Promise.all(batch.map(async (market: any) => {
                try {
                    // 1. Time Constraint: -24h to 96h (Widened to catch expiring/just expired)
                    const minTime = -24 * 60 * 60 * 1000; 
                    const maxTime = 96 * 60 * 60 * 1000; // 4 days
                    
                    let endTime = 0;
                    if (typeof market.endDate === 'number') {
                        // If endDate is huge, it's ms. If small, it's seconds.
                        endTime = market.endDate > 1_000_000_000_000 ? market.endDate : market.endDate * 1000;
                    } else {
                        endTime = new Date(market.endDate).getTime();
                    }

                    const now = Date.now();
                    const remainingTime = endTime - now;
                    
                    if (!market.endDate || remainingTime < minTime || remainingTime > maxTime) {
                        timeSkippedCount++;
                        return;
                    }

                    let clobMarket;
                    try {
                        clobMarket = await withRetry(() => this.sdk.clobApi.getMarket(market.conditionId), {
                            maxRetries: 2,
                        });
                    } catch (e: any) { return; }

                    const tokens = clobMarket.tokens;
                    if (!tokens || tokens.length < 2) return;

                    const isHighTemp = market.question.toLowerCase().includes('highest temperature');
                    if (!isHighTemp) return;

                    const getTokenId = (t: any): string | undefined => t?.token_id ?? t?.tokenId ?? t?.id;
                    const bestAskCentsByOutcome: Record<string, number> = {};
                    const tokenIds: string[] = [];

                    let bidSumCents = 0;
                    let minLiquidityFound = 999999;

                    const orderbookPromises = tokens.map((token: any) => {
                        const tokenId = getTokenId(token);
                        if (!tokenId) return Promise.resolve({ token, book: { asks: [], bids: [] } });
                        return withRetry(() => this.sdk.clobApi.getOrderbook(tokenId), { maxRetries: 1 })
                            .then((book: any) => ({ token, book }))
                            .catch(() => ({ token, book: { asks: [], bids: [] } }));
                    });

                    const orderbooks = await Promise.all(orderbookPromises);

                    for (const { token, book } of orderbooks) {
                        const tokenId = getTokenId(token);
                        if (tokenId) tokenIds.push(tokenId);

                        const outcome = String(token?.outcome ?? token?.name ?? '').toLowerCase();
                        const bestAsk = Number(book?.asks?.[0]?.price);
                        const askSize = Number(book?.asks?.[0]?.size);
                        const bestBid = Number(book?.bids?.[0]?.price);

                        if (!Number.isFinite(bestAsk) || bestAsk <= 0) return;
                        const askCents = bestAsk * 100;
                        bestAskCentsByOutcome[outcome] = askCents;

                        if (Number.isFinite(bestBid) && bestBid > 0) bidSumCents += bestBid * 100;
                        if (Number.isFinite(askSize) && askSize > 0) minLiquidityFound = Math.min(minLiquidityFound, askSize * askCents);
                    }

                    const yesCents = bestAskCentsByOutcome['yes'];
                    const noCents = bestAskCentsByOutcome['no'];
                    if (!Number.isFinite(yesCents) || !Number.isFinite(noCents)) return;

                    const totalCostCents = yesCents + noCents;
                    if (!(totalCostCents >= 99 && totalCostCents <= 130)) return;

                    const profitPercent = 100 - totalCostCents;
                    const profit = profitPercent / 100;
                    const ratioScore = 1 - Math.min(1, Math.abs((yesCents / totalCostCents) - 0.5) * 2);

                    if (true) {
                        opportunities.push({
                            marketId: market.conditionId,
                            gammaId: market.id,
                            question: market.question,
                            slug: market.slug || '',
                            outcomes: market.outcomes,
                            tokenIds,
                            prices: [yesCents, noCents],
                            yesPrice: yesCents,
                            noPrice: noCents,
                            totalCost: totalCostCents,
                            profit,
                            profitPercent,
                            liquidity: minLiquidityFound,
                            bidSum: bidSumCents,
                            endDate: market.endDate,
                            isWeather: true,
                            ratioScore,
                            image: market.image || market.icon,
                            volume24hr: (() => {
                                const raw = market.volume24hr ?? market.volume24h ?? market.volume ?? market.volumeNum;
                                const n = typeof raw === 'string' ? Number(raw) : Number(raw);
                                return Number.isFinite(n) ? n : undefined;
                            })()
                        });
                    }

                } catch (e) {
                    // ignore
                }
            }));
            
            await new Promise(r => setTimeout(r, 100));
        }
        
        log(`skipped ${timeSkippedCount} markets due to time window (0h-96h).`);
        log(`✅ Found ${opportunities.length} opportunities.`);

        return { 
            opportunities: opportunities.sort((a, b) => {
                const diffA = Math.abs(a.totalCost - 100);
                const diffB = Math.abs(b.totalCost - 100);
                if (diffA !== diffB) return diffA - diffB;
                return a.totalCost - b.totalCost;
            }), 
            logs 
        };
    }

    // Public method for route to get cached results
    getResults() {
        return {
            opportunities: this.latestResults,
            logs: this.latestLogs,
            count: this.latestResults.length
        };
    }

    // Get Active Orders (For Monitoring)
    async getActiveOrders(marketId?: string): Promise<any[]> {
        // If marketId is provided, fetch for that market.
        if (marketId) {
             const orders = await this.tradingClient.getOpenOrders(marketId);
             return orders || [];
        }
        
        return [];
    }

    getFunderAddress(): string {
        return this.tradingClient.getFunderAddress();
    }

    async getAllOpenOrders(): Promise<any[]> {
        const orders = await this.tradingClient.getOpenOrders();
        return orders || [];
    }

    async getTrades(params?: any): Promise<any[]> {
        return await this.tradingClient.getTrades(params);
    }

    async getTradingStatus(): Promise<any> {
        try {
            const ok = await this.tradingClient.getOk();
            return { ok: true, clob: ok, funder: this.getFunderAddress() };
        } catch (e: any) {
            return { ok: false, funder: this.getFunderAddress(), error: e?.message || String(e) };
        }
    }

    async getCtfCustody(marketId: string): Promise<any> {
        const market = await withRetry(() => this.sdk.clobApi.getMarket(marketId), { maxRetries: 2 });
        const tokens = market.tokens || [];
        const yesToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'yes');
        const noToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'no');
        const yesTokenId = yesToken?.token_id ?? yesToken?.tokenId ?? yesToken?.id;
        const noTokenId = noToken?.token_id ?? noToken?.tokenId ?? noToken?.id;

        const signer = this.tradingClient.getSignerAddress();
        const funder = this.getFunderAddress();

        const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
        const conditionalTokens = new ethers.Contract(
            '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
            ['function balanceOf(address account, uint256 id) view returns (uint256)'],
            provider
        );

        const fmt = (v: any) => ethers.utils.formatUnits(v, 6);
        const getBal = async (addr: string, tid: string | undefined) => {
            if (!addr || !tid) return '0';
            const b = await conditionalTokens.balanceOf(addr, tid);
            return fmt(b);
        };

        const [signerYes, signerNo, funderYes, funderNo] = await Promise.all([
            getBal(signer, yesTokenId),
            getBal(signer, noTokenId),
            getBal(funder, yesTokenId),
            getBal(funder, noTokenId),
        ]);

        return {
            marketId,
            question: market.question,
            signer,
            funder,
            tokenIds: { yesTokenId, noTokenId },
            balances: {
                signer: { yes: signerYes, no: signerNo },
                funder: { yes: funderYes, no: funderNo },
            },
        };
    }

    async cancelOrder(orderId: string): Promise<any> {
        return await this.tradingClient.cancelOrder(orderId);
    }

    // New: Get Persistent Order History
    getHistory() {
        return this.orderHistory;
    }

    private extractMarketSlug(identifier: string): string | null {
        if (!identifier) return null;
        const trimmed = identifier.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('0x')) return null;
        try {
            if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                const u = new URL(trimmed);
                const parts = u.pathname.split('/').filter(Boolean);
                if (parts.length === 0) return null;
                return parts[parts.length - 1];
            }
        } catch {
        }
        const parts = trimmed.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : trimmed;
    }

    async resolveIdentifier(identifier: string): Promise<{ marketId: string; slug?: string; question?: string; gammaId?: string }> {
        const trimmed = (identifier || '').trim();
        if (!trimmed) throw new Error('Missing identifier');
        if (trimmed.startsWith('0x')) {
            const gamma = await withRetry(() => this.sdk.gammaApi.getMarketByConditionId(trimmed), { maxRetries: 2 });
            return { marketId: trimmed, slug: gamma?.slug, question: gamma?.question, gammaId: gamma?.id };
        }
        const slug = this.extractMarketSlug(trimmed);
        if (!slug) throw new Error('Could not extract market slug');
        const gamma = await withRetry(() => this.sdk.gammaApi.getMarketBySlug(slug), { maxRetries: 2 });
        if (!gamma?.conditionId) throw new Error('Market not found for slug');
        return { marketId: gamma.conditionId, slug: gamma.slug, question: gamma.question, gammaId: gamma.id };
    }

    async getOrderbookLadder(identifier: string, depth = 5): Promise<any> {
        const resolved = await this.resolveIdentifier(identifier);
        const market = await withRetry(() => this.sdk.clobApi.getMarket(resolved.marketId), { maxRetries: 2 });
        const tokens = market.tokens || [];
        const yesToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'yes') || tokens[0];
        const noToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'no') || tokens[1];

        const yesTokenId = yesToken?.token_id ?? yesToken?.tokenId ?? yesToken?.id;
        const noTokenId = noToken?.token_id ?? noToken?.tokenId ?? noToken?.id;
        if (!yesTokenId || !noTokenId) throw new Error('Missing token ids');

        const [yesOb, noOb] = await Promise.all([
            this.sdk.clobApi.getOrderbook(yesTokenId),
            this.sdk.clobApi.getOrderbook(noTokenId),
        ]);

        const pick = (rows: any[]) => (Array.isArray(rows) ? rows.slice(0, depth).map((r: any) => ({ price: Number(r.price), size: Number(r.size) })) : []);

        return {
            identifier,
            marketId: resolved.marketId,
            slug: resolved.slug,
            question: market.question,
            tokenIds: { yesTokenId, noTokenId },
            yes: { bids: pick(yesOb?.bids), asks: pick(yesOb?.asks) },
            no: { bids: pick(noOb?.bids), asks: pick(noOb?.asks) },
        };
    }

    async executeManual(params: { identifier: string; yesPrice: number; noPrice: number; size: number; orderType?: 'GTC' | 'GTD' }): Promise<any> {
        if (!this.hasValidKey) {
            const error = "❌ Error: Missing Private Key. Please set POLY_PRIVKEY in .env. API Key provided is not enough for trading.";
            console.error(error);
            return { success: false, error };
        }

        const { identifier, yesPrice, noPrice, size } = params;
        const orderType = params.orderType || 'GTC';
        const resolved = await this.resolveIdentifier(identifier);
        const market = await withRetry(() => this.sdk.clobApi.getMarket(resolved.marketId), { maxRetries: 2 });
        const tokens = market.tokens || [];
        const yesToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'yes') || tokens[0];
        const noToken = tokens.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'no') || tokens[1];

        const yesTokenId = yesToken?.token_id ?? yesToken?.tokenId ?? yesToken?.id;
        const noTokenId = noToken?.token_id ?? noToken?.tokenId ?? noToken?.id;
        if (!yesTokenId || !noTokenId) throw new Error('Missing token ids');

        const results: any[] = [];

        const place = async (tokenId: string, outcome: string, price: number) => {
            const order = await this.tradingClient.createOrder({
                tokenId,
                price,
                side: 'BUY',
                size,
                orderType,
            });
            results.push({
                tokenId,
                outcome,
                success: !!order.success,
                orderId: order.orderId,
                tx: order.transactionHashes?.[0],
                error: order.success ? undefined : (order.errorMsg || order.rawStatus || 'Order rejected'),
                price,
                size
            });
        };

        await place(yesTokenId, 'Yes', Number(yesPrice));
        await place(noTokenId, 'No', Number(noPrice));

        const openOrders = await this.tradingClient.getOpenOrders(resolved.marketId).catch(() => []);

        const historyEntry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            marketId: resolved.marketId,
            marketQuestion: market.question,
            mode: 'manual',
            identifier,
            params: { yesPrice, noPrice, size, orderType },
            results,
            openOrdersCount: openOrders.length
        };

        this.orderHistory.unshift(historyEntry);
        if (this.orderHistory.length > 50) this.orderHistory.pop();

        return { success: true, marketId: resolved.marketId, question: market.question, results, openOrders };
    }

    async preview(marketId: string, amount: number): Promise<any> {
        const market = await withRetry(() => this.sdk.clobApi.getMarket(marketId), { maxRetries: 2 });
        const tokens = market.tokens;

        if (!tokens || tokens.length < 2) {
            throw new Error("Invalid market tokens");
        }

        const orderbooksMap = new Map();
        let totalAskSum = 0;
        let canCalculate = true;
        const getTokenId = (t: any): string | undefined => t?.token_id ?? t?.tokenId ?? t?.id;

        for (const token of tokens) {
            try {
                const tokenId = getTokenId(token);
                if (!tokenId) {
                    canCalculate = false;
                    continue;
                }
                const ob = await this.sdk.clobApi.getOrderbook(tokenId);
                orderbooksMap.set(tokenId, ob);
                const bestAsk = Number(ob.asks[0]?.price);
                if (!bestAsk) {
                    canCalculate = false;
                } else {
                    totalAskSum += bestAsk;
                }
            } catch (e) {
                canCalculate = false;
            }
        }

        let targetDiscountFactor = 0.90;
        let effectiveDiscountPercent = 10;
        let plannedTotalBidCost = totalAskSum * targetDiscountFactor;

        if (canCalculate) {
            const TARGET_TOTAL_COST = 0.90;
            let scalingFactor = TARGET_TOTAL_COST / totalAskSum;
            if (scalingFactor > 0.99) scalingFactor = 0.99;
            targetDiscountFactor = scalingFactor;
            effectiveDiscountPercent = (1 - targetDiscountFactor) * 100;
            plannedTotalBidCost = totalAskSum * targetDiscountFactor;
        }

        const setsToBuy = plannedTotalBidCost > 0 ? Number((amount / plannedTotalBidCost).toFixed(2)) : 0;

        const legs = tokens.slice(0, 2).map((token: any) => {
            const tokenId = getTokenId(token);
            const ob = tokenId ? orderbooksMap.get(tokenId) : undefined;
            const bestAsk = Number(ob?.asks?.[0]?.price);
            const targetPrice = Number((bestAsk * targetDiscountFactor).toFixed(3));
            let finalPrice = targetPrice;
            if (finalPrice >= bestAsk) finalPrice = bestAsk - 0.001;
            if (finalPrice <= 0) finalPrice = 0.01;
            return {
                outcome: token.outcome,
                tokenId: tokenId,
                currentAsk: bestAsk,
                targetBid: finalPrice,
                size: setsToBuy
            };
        });

        return {
            marketId,
            question: market.question,
            amount,
            totalAsk: totalAskSum,
            targetTotal: plannedTotalBidCost,
            discountFactor: targetDiscountFactor,
            discountPercent: effectiveDiscountPercent,
            setsToBuy,
            legs
        };
    }

    async execute(marketId: string, amount: number): Promise<any> {
        console.log(`🚀 Executing Group Arb for Market: ${marketId}, Amount: $${amount}`);
        
        if (!this.hasValidKey) {
            const error = "❌ Error: Missing Private Key. Please set POLY_PRIVKEY in .env. API Key provided is not enough for trading.";
            console.error(error);
            return { success: false, error };
        }

        const market = await withRetry(() => this.sdk.clobApi.getMarket(marketId), { maxRetries: 2 });
        const tokens = market.tokens;

        if (!tokens || tokens.length < 2) {
            throw new Error("Invalid market tokens");
        }

        const results = [];
        const tokenIds: string[] = [];
        
        // --- STEP 1: Fetch ALL Orderbooks First to Calculate Total Cost ---
        console.log(`   🔍 Fetching orderbooks to calculate spread...`);
        const orderbooksMap = new Map();
        let totalAskSum = 0;
        let canCalculate = true;

        for (const token of tokens) {
            try {
                const tokenId = token.token_id ?? token.tokenId ?? token.id;
                if (!tokenId) {
                    canCalculate = false;
                    continue;
                }
                const ob = await this.sdk.clobApi.getOrderbook(tokenId);
                orderbooksMap.set(tokenId, ob);
                tokenIds.push(tokenId);
                
                const bestAsk = Number(ob.asks[0]?.price);
                if (!bestAsk) {
                    canCalculate = false; // Missing liquidity on one side
                } else {
                    totalAskSum += bestAsk;
                }
            } catch (e) {
                canCalculate = false;
            }
        }

        // --- STEP 2: Determine Discount Logic (Dynamic Target Cost) ---
        // Goal: Total Bid Cost must be <= $0.90 to guarantee 10% profit.
        // Formula: DiscountFactor = 0.90 / TotalAskSum
        
        let targetDiscountFactor = 0.90; // Default to 10% discount if TotalAsk is 1.00
        let effectiveDiscountPercent = 10;
        let plannedTotalBidCost = totalAskSum * targetDiscountFactor;

        if (canCalculate) {
            const TARGET_TOTAL_COST = 0.90;
            
            // Calculate the scaling factor needed to bring TotalAskSum down to 0.90
            let scalingFactor = TARGET_TOTAL_COST / totalAskSum;
            
            // Safety: Never bid at/above ask
            if (scalingFactor > 0.99) scalingFactor = 0.99;
            
            targetDiscountFactor = scalingFactor;
            effectiveDiscountPercent = (1 - targetDiscountFactor) * 100;
            plannedTotalBidCost = totalAskSum * targetDiscountFactor;

            console.log(`   💰 Total Ask Cost: $${totalAskSum.toFixed(3)}`);
            console.log(`   🎯 Target Cost: $${TARGET_TOTAL_COST.toFixed(2)} (10% Profit Target)`);
            console.log(`   📉 Applied Scaling Factor: ${targetDiscountFactor.toFixed(4)} (${effectiveDiscountPercent.toFixed(1)}% Discount)`);
            
        } else {
            console.warn(`   ⚠️ Could not calculate total spread (missing liquidity). Defaulting to 10% discount.`);
        }

        const setsToBuy = plannedTotalBidCost > 0 ? Number((amount / plannedTotalBidCost).toFixed(2)) : 0;

        // --- STEP 3: Place Orders ---
        for (const token of tokens) {
            try {
                const tokenId = token.token_id ?? token.tokenId ?? token.id;
                const ob = tokenId ? orderbooksMap.get(tokenId) : undefined;
                if (!ob) continue; // Should have been fetched above

                const bestAsk = Number(ob.asks[0]?.price);
                
                if (!bestAsk) {
                    results.push({ tokenId: tokenId, success: false, error: "No liquidity" });
                    continue;
                }

                if (!tokenId) {
                    results.push({ tokenId: null, success: false, error: "Missing token_id", outcome: token.outcome });
                    continue;
                }

                // Apply the calculated scaling factor
                const targetPrice = Number((bestAsk * targetDiscountFactor).toFixed(3)); 
                
                let finalPrice = targetPrice;
                if (finalPrice >= bestAsk) finalPrice = bestAsk - 0.001;
                if (finalPrice <= 0) finalPrice = 0.01; // Minimum price

                const sharesToBuy = setsToBuy;

                console.log(`   Buying ${token.outcome} (ID: ${token.token_id})`);
                console.log(`      Current Ask: ${bestAsk}`);
                console.log(`      Target Bid: ${finalPrice} (${effectiveDiscountPercent.toFixed(1)}% discount)`);
                console.log(`      Size: ${sharesToBuy} shares`);
                
                const order = await this.tradingClient.createOrder({
                    tokenId: tokenId, 
                    price: finalPrice,
                    side: 'BUY',
                    size: sharesToBuy,
                    orderType: 'GTC', 
                });

                results.push({ 
                    tokenId: tokenId, 
                    success: !!order.success, 
                    orderId: order.orderId, 
                    tx: order.transactionHashes?.[0], 
                    outcome: token.outcome,
                    error: order.success ? undefined : (order.errorMsg || order.rawStatus || 'Order rejected')
                });

            } catch (e: any) {
                console.error(`   Failed to buy ${token.outcome}: ${e.message}`);
                results.push({ tokenId: token.token_id ?? token.tokenId ?? token.id, success: false, error: e.message, outcome: token.outcome });
            }
        }
        
        console.log(`   ⚠️ Orders placed as GTC (Maker). Auto-merge skipped until filled.`);

        // --- STEP 4: Register for Monitoring (Cut Loss / Trailing Stop) ---
        if (canCalculate) {
            this.monitoredTrades.set(marketId, {
                marketId,
                entryTime: Date.now(),
                entryPrice: totalAskSum, // Approximate entry cost (if filled)
                peakPrice: totalAskSum, // Start tracking peak from here
                tokenIds,
                status: 'active'
            });
            console.log(`   📡 Trade registered for monitoring (Cut Loss: 3h, Trailing Stop: 10%)`);
        }

        console.log(`   ⏳ Waiting 1s for order propagation...`);
        await new Promise(r => setTimeout(r, 1000));
        
        let openOrders = [];
        try {
            console.log(`   🔍 Tracking: Fetching Open Orders for Market ${marketId}...`);
            openOrders = await this.tradingClient.getOpenOrders(marketId);
        } catch (e: any) {
            console.error(`   Failed to track orders: ${e.message}`);
        }

        // Store in history
        const historyEntry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            marketId,
            marketQuestion: market.question, 
            amount,
            results,
            openOrdersCount: openOrders.length
        };
        
        // Add to history (limit to 50)
        this.orderHistory.unshift(historyEntry);
        if (this.orderHistory.length > 50) this.orderHistory.pop();

        return { success: true, results, openOrders };
    }

    // Monitoring Loop for Cut Loss / Trailing Stop
    private async startMonitoring() {
        setInterval(async () => {
            if (this.monitoredTrades.size === 0) return;

            console.log(`🔍 Monitoring ${this.monitoredTrades.size} active trades...`);
            
            for (const [marketId, trade] of this.monitoredTrades) {
                if (trade.status === 'closed') {
                    this.monitoredTrades.delete(marketId);
                    continue;
                }

                try {
                    // Check time elapsed
                    const hoursElapsed = (Date.now() - trade.entryTime) / (1000 * 60 * 60);
                    
                    if (hoursElapsed < 3) continue; // Only act after 3 hours as per requirement

                    // Fetch current prices
                    let currentTotalCost = 0;
                    for (const tid of trade.tokenIds) {
                        const ob = await this.sdk.clobApi.getOrderbook(tid);
                        const bestAsk = Number(ob.asks[0]?.price) || 0;
                        currentTotalCost += bestAsk;
                    }

                    if (currentTotalCost === 0) continue; // No liquidity to price

                    // Update Peak Price
                    if (currentTotalCost > trade.peakPrice) {
                        trade.peakPrice = currentTotalCost;
                    }

                    // Rule 8: Cut Loss (Price Drop)
                    if (currentTotalCost < trade.entryPrice) {
                        console.log(`⚠️ CUT LOSS ALERT: Market ${marketId} dropped below entry after 3h.`);
                        // Logic: Cancel orders and Sell (Placeholder for now)
                        // await this.tradingClient.cancelAllOrders(marketId);
                        // await this.sellAll(marketId);
                        trade.status = 'closed';
                    }

                    // Rule 9: Trailing Stop (10% Drop from Peak)
                    const dropFromPeak = (trade.peakPrice - currentTotalCost) / trade.peakPrice;
                    if (currentTotalCost > trade.entryPrice && dropFromPeak >= 0.10) {
                        console.log(`📉 TRAILING STOP ALERT: Market ${marketId} dropped 10% from peak.`);
                        // Logic: Sell to secure profit
                        trade.status = 'closed';
                    }

                } catch (e) {
                    console.error(`Error monitoring market ${marketId}:`, e);
                }
            }
        }, 60000); // Run every minute
    }
}
