import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

async function main() {
    const pk = process.env.POLY_PRIVKEY;
    if (!pk) {
        console.error("No private key found in process.env");
        return;
    }
    const wallet = new Wallet(pk);
    console.log(`Signer Address (L1): ${wallet.address}`);

    // Init Client
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
    
    try {
        console.log("Deriving API Keys...");
        const creds = await client.createOrDeriveApiKey();
        console.log("✅ API Credentials Obtained.");
        
        const clientL2 = new ClobClient(
            'https://clob.polymarket.com', 
            137, 
            wallet, 
            creds, 
            1, // SignatureType.POLY_PROXY
            wallet.address // Intentionally using Signer as Funder to test
        );

        console.log("Testing auth with Signer as Funder...");
        
        try {
            const trades = await clientL2.getTrades({ limit: 1 });
            console.log("Trades fetched successfully.");
        } catch (e: any) {
             console.log("❌ Request failed as expected.");
             console.log(`Error Message: ${e.message}`);
        }

    } catch (e: any) {
        console.error("Setup failed:", e.message);
    }
}

main();
