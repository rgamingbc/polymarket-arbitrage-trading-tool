import { PolymarketSDK } from '../../../dist/index.js';
import { config } from '../config.js';

const sdk = new PolymarketSDK({ privateKey: config.polymarket.privateKey } as any);

async function main() {
    console.log("Searching for market...");
    const slug = "highest-temperature-in-toronto-on-january-26-neg-9c";
    
    try {
        // Try getting market by slug (Gamma API usually takes the question slug or ID)
        // Since we don't have a direct "get by slug" easily exposed sometimes, we can search.
        const markets = await sdk.gammaApi.getMarkets({
            limit: 50,
            active: true,
            closed: false
        });
        
        // Filter manually
        const match = markets.find((m: any) => m.slug === slug || m.question.includes("Toronto") && m.question.includes("-9"));
        
        if (match) {
            console.log(JSON.stringify(match, null, 2));
            console.log(`FOUND_MARKET_ID: ${match.conditionId}`);
        } else {
            console.log("Market not found in top 50. Trying deeper search...");
             const marketsDeep = await sdk.gammaApi.getMarkets({
                limit: 100,
                active: true,
                closed: false,
                offset: 100
            });
            const matchDeep = marketsDeep.find((m: any) => m.slug === slug || m.question.includes("Toronto") && m.question.includes("-9"));
             if (matchDeep) {
                console.log(JSON.stringify(matchDeep, null, 2));
                console.log(`FOUND_MARKET_ID: ${matchDeep.conditionId}`);
            } else {
                console.log("Still not found.");
            }
        }
    } catch (e) {
        console.error(e);
    }
}

main();
