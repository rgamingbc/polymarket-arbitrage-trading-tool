import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import { TradingClientOverride } from '../clients/trading-client-override.js';
import { RateLimiter, ApiType } from '../../../dist/index.js';

// Load env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const RPC_URL = 'https://polygon-rpc.com';

async function main() {
    const privateKey = process.env.POLY_PRIVKEY;
    const proxyAddress = process.env.POLY_PROXY_ADDRESS;

    if (!privateKey || !proxyAddress) {
        console.error("❌ Missing POLY_PRIVKEY or POLY_PROXY_ADDRESS in .env");
        return;
    }

    console.log(`🔍 Debugging Proxy Trading for: ${proxyAddress}`);

    // 1. Fetch a valid Token ID from Gamma API (with headers)
    console.log("🌍 Fetching a valid market token...");
    try {
        const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=1', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        });
        
        if (!gammaRes.ok) {
            console.error(`Gamma API Error: ${gammaRes.status} ${gammaRes.statusText}`);
            const text = await gammaRes.text();
            console.error("Body:", text.substring(0, 200));
            return;
        }

        const markets = await gammaRes.json();
        
        if (!markets || markets.length === 0) {
            console.error("❌ Could not fetch any markets from Gamma API");
            return;
        }

        const market = markets[0];
        console.log(`   Found Market: ${market.question}`);
        
        // Use CLOB API to get tokens
        const clobRes = await fetch(`https://clob.polymarket.com/markets/${market.conditionId}`);
        const clobMarket = await clobRes.json();
        
        if (!clobMarket.tokens || clobMarket.tokens.length === 0) {
            console.error("❌ Could not fetch CLOB tokens");
            return;
        }

        const token = clobMarket.tokens[0]; 
        const tokenId = token.token_id;
        console.log(`🎯 Target Token: ${token.outcome} (ID: ${tokenId})`);

        // 2. Initialize Trading Client
        console.log("\n🧪 Initializing Trading Client...");
        const rateLimiter = new RateLimiter();
        const client = new TradingClientOverride(rateLimiter, {
            privateKey: privateKey,
            chainId: 137,
            proxyAddress: proxyAddress
        });

        await client.initialize();

        // 3. Place Order
        console.log("\n🚀 Placing Limit Buy Order @ $0.01 (Size: 5)...");
        const result = await client.createOrder({
            tokenId: tokenId,
            price: 0.01,
            side: 'BUY',
            size: 5, // 5 shares @ $0.01 = $0.05
            orderType: 'GTC'
        });

        console.log("📝 Order Result:", JSON.stringify(result, null, 2));

        if (result.success) {
            console.log("✅ Order Placed Successfully!");
            console.log(`   Order ID: ${result.orderId}`);
            
            // 4. Verify it appears in Open Orders
            console.log("\n�� Verifying Open Orders...");
            await new Promise(r => setTimeout(r, 2000)); // Wait for propagation
            const orders = await client.getOpenOrders();
            console.log(`   Open Orders Found: ${orders.length}`);
            
            const myOrder = orders.find((o: any) => o.id === result.orderId);
            if (myOrder) {
                console.log("✅ Order Verified in Orderbook!");
                
                // 5. Cancel it
                console.log("\n🗑️ Cancelling Order...");
                // Access private clobClient or use public method if available?
                // TradingClientOverride doesn't expose cancelOrder directly in my snippet?
                // Wait, it doesn't. I'll cast to any.
                const cancelRes = await (client as any).clobClient.cancelOrder({ orderID: result.orderId });
                console.log("   Cancel Result:", cancelRes);
            } else {
                console.warn("⚠️ Order placed but not found in Open Orders (might be filled or cancelled immediately?)");
                console.log("   All Open Orders:", JSON.stringify(orders, null, 2));
            }
        } else {
            console.error("❌ Order Placement Failed:", result.errorMsg);
        }

    } catch (e: any) {
        console.error("❌ Error:", e.message);
    }
}

main().catch(console.error);
