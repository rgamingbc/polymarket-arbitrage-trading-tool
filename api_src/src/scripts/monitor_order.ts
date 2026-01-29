import axios from 'axios';

async function main() {
    console.log("🕵️‍♂️ Starting 2-minute monitor for 'Toronto' orders...");
    const endTime = Date.now() + 2 * 60 * 1000;
    
    let found = false;
    
    while (Date.now() < endTime) {
        try {
            const res = await axios.get('http://localhost:3000/api/group-arb/history');
            const history = res.data.history || [];
            
            // Find recent order for Toronto
            const match = history.find((h: any) => 
                (h.marketQuestion && h.marketQuestion.includes('Toronto')) ||
                (h.marketId && h.marketId.includes('Toronto')) // unlikely but check
            );
            
            if (match) {
                console.log("\n✅ Order Detected!");
                console.log(`Time: ${new Date(match.timestamp).toLocaleString()}`);
                console.log(`Market: ${match.marketQuestion}`);
                console.log(`Amount: $${match.amount}`);
                console.log("Results:");
                match.results.forEach((r: any) => {
                    console.log(`   ${r.outcome}: ${r.success ? '✅ Success' : '❌ Failed'} ${r.error ? `(${r.error})` : ''}`);
                });
                
                if (match.openOrdersCount > 0) {
                     console.log(`\n🌊 Open Orders: ${match.openOrdersCount} are currently active in the book.`);
                } else {
                     console.log(`\n💨 Status: Orders filled or cancelled (No open orders).`);
                }
                
                found = true;
                break;
            }
            
            process.stdout.write(".");
        } catch (e) {
            // ignore
        }
        
        await new Promise(r => setTimeout(r, 2000));
    }
    
    if (!found) {
        console.log("\n❌ No 'Toronto' order detected in the last 2 minutes.");
    }
}

main();
