
import { FastifyPluginAsync } from 'fastify';
import { PolymarketSDK, withRetry, RateLimiter, ApiType } from '../../../dist/index.js';
import { config } from '../config.js';

export const thetaFarmerRoutes: FastifyPluginAsync = async (fastify) => {
    const rateLimiter = new RateLimiter({
        [ApiType.DATA]: { maxConcurrent: 5, minTime: 200 },
        [ApiType.GAMMA]: { maxConcurrent: 5, minTime: 200 },
        [ApiType.CLOB]: { maxConcurrent: 2, minTime: 500 },
    });
    
    const sdk = new PolymarketSDK({
        rateLimiter,
        privateKey: config.polymarket.privateKey,
    } as any);

    fastify.get('/analyze', {
        schema: {
            tags: ['Theta Farmer'],
            summary: 'Analyze Cumulative Markets for Calendar Spreads',
            querystring: {
                type: 'object',
                properties: {
                    query: { type: 'string', default: 'us-strikes-iran' },
                },
            },
        },
        handler: async (request, reply) => {
            const { query } = request.query as any;
            
            // 1. Search Markets
            // Fetch more markets to increase discovery chance
            const markets = await withRetry(() => sdk.gammaApi.getMarkets({
                closed: false,
                active: true,
                limit: 500, // Increase limit
                offset: 0
            }), { maxRetries: 3 });

            // "Discover" mode: If query is empty or 'discover', find series automatically
            let seriesMarkets = [];
            
            if (!query || query === 'discover') {
                // Auto-discovery logic
                // Group by similar questions
                const groups: Record<string, any[]> = {};
                
                markets.forEach((m: any) => {
                    // Pattern: "Will [Event] happen by [Date]?" or similar
                    // Try to extract the "Event" part
                    // Common patterns:
                    // "Will [X] be [Y] by [Date]?"
                    // "Will [X] happen by [Date]?"
                    // "[X] price by [Date]?"
                    
                    const match = m.question.match(/^(Will .*?) by [A-Za-z]+ \d+/);
                    if (match) {
                        const key = match[1];
                        if (!groups[key]) groups[key] = [];
                        groups[key].push(m);
                    }
                });
                
                // Return all series with >= 2 dates
                const allSeries = Object.values(groups).filter(g => g.length >= 2);
                
                if (allSeries.length === 0) {
                     return { error: 'No series found. Try specific query.' };
                }
                
                // Flatten for now, or maybe just return the first found large series?
                // Let's return the largest series found
                allSeries.sort((a, b) => b.length - a.length);
                seriesMarkets = allSeries[0]; // Return the biggest series found
                
                // If user wants list of series, we might need a different endpoint.
                // For now, let's just analyze the biggest one found.
            } else {
                 // Filter by slug/question
                seriesMarkets = markets.filter((m: any) => 
                    m.slug.includes(query) || m.question.toLowerCase().includes(query.toLowerCase())
                );
            }

            if (seriesMarkets.length === 0) {
                return { error: 'No markets found for query' };
            }

            // 2. Parse Dates
            // Extract date from question or slug
            const data = seriesMarkets.map((m: any) => {
                // Try to find date in question "by Month Day" or "by Month Day, Year"
                // Heuristic parsing
                const dateMatch = m.question.match(/by ([A-Za-z]+ \d{1,2}(, \d{4})?)/);
                const dateStr = dateMatch ? dateMatch[1] : 'Unknown';
                
                // Fetch prices
                // Gamma market object usually has outcomes and prices?
                // Let's assume we need to fetch CLOB or use Gamma cached prices if reliable.
                // Gamma prices are usually reliable enough for analysis.
                
                // Find YES price
                // outcomePrices is array string
                // outcomes is array string
                
                let yesPrice = 0;
                let noPrice = 0;
                
                try {
                    const yesIndex = JSON.parse(m.outcomes).indexOf('Yes');
                    if (yesIndex !== -1 && m.outcomePrices) {
                        yesPrice = parseFloat(JSON.parse(m.outcomePrices)[yesIndex]);
                        noPrice = 1 - yesPrice;
                    }
                } catch (e) {}

                return {
                    id: m.conditionId,
                    question: m.question,
                    endDate: m.endDate, // ISO string
                    yesPrice,
                    noPrice,
                    volume: m.volume24hr,
                };
            });

            // Sort by Date
            data.sort((a: any, b: any) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

            // 3. Analyze Spread
            const analysis = [];
            for (let i = 0; i < data.length - 1; i++) {
                const near = data[i];
                const far = data[i+1];
                
                // Spread: Far YES should be >= Near YES
                // If Near YES > Far YES, that's an arbitrage (or data error)
                // If Far YES >> Near YES, that's the "Theta" or probability of event happening in between.
                
                const spread = far.yesPrice - near.yesPrice;
                const monthlyProb = spread; // Roughly probability event happens in this interval
                
                analysis.push({
                    interval: `${near.question} -> ${far.question}`,
                    spread: spread.toFixed(4),
                    impliedProbability: (spread * 100).toFixed(2) + '%',
                    action: spread < 0 ? 'ARBITRAGE: Sell Near / Buy Far' : 'Normal Curve'
                });
            }

            return {
                series: data,
                analysis
            };
        }
    });
};
