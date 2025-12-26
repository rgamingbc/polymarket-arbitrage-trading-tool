
import { PolymarketSDK } from './src/index.js';

async function debugWallet() {
    const sdk = new PolymarketSDK();
    const address = '0x02a17a92e6f673129b37d95359c7af628a3cdd72';

    console.log(`Checking address: ${address}`);

    try {
        const profile = await sdk.wallets.getWalletProfile(address);
        console.log('Profile:', JSON.stringify(profile, null, 2));

        const activity = await sdk.dataApi.getActivity(address, { limit: 10 });
        console.log('Recent Activity Count:', activity.length);
        if (activity.length > 0) {
            console.log('First activity type:', activity[0].type);
        }

        const stats = await sdk.wallets.getWalletProfileForPeriod(address, 0); // ALL
        console.log('Stats (ALL):', JSON.stringify(stats, null, 2));

    } catch (error) {
        console.error('Error:', error);
    }
}

debugWallet();
