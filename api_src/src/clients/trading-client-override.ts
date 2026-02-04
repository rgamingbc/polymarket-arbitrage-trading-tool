import { ClobClient, Side as ClobSide, OrderType as ClobOrderType, Chain, type OpenOrder, type Trade as ClobTrade, type TickSize } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { RateLimiter, ApiType } from '../../../dist/index.js';

// Chain IDs
export const POLYGON_MAINNET = 137;

// CLOB Host
const CLOB_HOST = 'https://clob.polymarket.com';

export interface ApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

export interface TradingClientConfig {
  privateKey: string;
  chainId?: number;
  credentials?: ApiCredentials;
  proxyAddress?: string; // New: Proxy Address (Funder)
}

export class TradingClientOverride {
  private clobClient: ClobClient | null = null;
  private wallet: Wallet;
  private chainId: Chain;
  private credentials: ApiCredentials | null = null;
  private initialized = false;
  private proxyAddress: string | undefined;

  private normalizeErrorMsg(raw: any): string {
    const s =
      raw == null ? ''
      : typeof raw === 'string' ? raw
      : raw instanceof Error ? raw.message
      : typeof raw?.message === 'string' ? raw.message
      : (() => {
          try { return JSON.stringify(raw); } catch { return String(raw); }
        })();
    const t = String(s || '').trim();
    if (!t) return 'unknown_error';
    if (t.length > 500) return `${t.slice(0, 500)}…`;
    return t;
  }

  constructor(
    private rateLimiter: RateLimiter,
    private config: TradingClientConfig
  ) {
    this.wallet = new Wallet(config.privateKey);
    this.chainId = (config.chainId || POLYGON_MAINNET) as Chain;
    this.credentials = config.credentials || null;
    this.proxyAddress = config.proxyAddress;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create CLOB client with L1 auth (wallet)
    // Note: If we have a proxy, we must use signatureType=1 eventually.
    // But for createOrDeriveApiKey, we use the signer (L1).
    this.clobClient = new ClobClient(CLOB_HOST, this.chainId, this.wallet);

    if (!this.credentials) {
      try {
        console.log('Attempting to create or derive API key...');
        const creds = await this.clobClient.createOrDeriveApiKey();
        this.credentials = {
          key: creds.key,
          secret: creds.secret,
          passphrase: creds.passphrase,
        };
        console.log('Successfully obtained API credentials');
      } catch (error: any) {
        console.warn('Standard createOrDeriveApiKey failed:', error.message);
        
        // Fallback Strategy: Try explicit derive then explicit create
        try {
             console.log('Fallback: Trying deriveApiKey...');
             const creds = await this.clobClient.deriveApiKey();
             this.credentials = {
                key: creds.key,
                secret: creds.secret,
                passphrase: creds.passphrase,
             };
             console.log('Fallback success: Derived API key');
        } catch (deriveError: any) {
             console.warn('Fallback derive failed:', deriveError.message);
             console.log('Fallback: Trying createApiKey...');
             // If derive failed, try create
             const creds = await this.clobClient.createApiKey();
             this.credentials = {
                key: creds.key,
                secret: creds.secret,
                passphrase: creds.passphrase,
             };
             console.log('Fallback success: Created API key');
        }
      }
    }

    if (!this.credentials?.key || !this.credentials?.secret || !this.credentials?.passphrase) {
        throw new Error("Failed to obtain API credentials after all attempts");
    }

    // Re-initialize with L2 auth (credentials)
    // IMPORTANT: If proxyAddress is set, assume Magic Link -> signatureType = 1
    const signatureType = this.proxyAddress ? 1 : 0;
    const funder = this.proxyAddress ? this.proxyAddress : undefined;

    console.log(`Initializing CLOB Client with SignatureType: ${signatureType}, Funder: ${funder || 'EOA'}`);

    this.clobClient = new ClobClient(
      CLOB_HOST,
      this.chainId,
      this.wallet,
      {
        key: this.credentials.key,
        secret: this.credentials.secret,
        passphrase: this.credentials.passphrase,
      },
      signatureType,
      funder
    );

    this.initialized = true;
  }

  async getOk(): Promise<any> {
      if (!this.clobClient) await this.initialize();
      return await this.clobClient!.getOk();
  }

  private normalizePrice(price: number, tickSize?: TickSize): number {
    if (!Number.isFinite(price) || price <= 0) return price;
    if (!tickSize) return price;
    const step = Number(tickSize);
    if (!Number.isFinite(step) || step <= 0) return price;
    const epsilon = step * 1e-9;
    const rounded = Math.floor((price + epsilon) / step) * step;
    const decimals = tickSize.includes('.') ? tickSize.split('.')[1].length : 0;
    return Number(Math.max(step, rounded).toFixed(decimals));
  }

  getFunderAddress(): string {
    return this.proxyAddress || this.wallet.address;
  }

  getSignerAddress(): string {
    return this.wallet.address;
  }

  // Simplified methods for what we need
  async createOrder(params: any): Promise<any> {
      if (!this.clobClient) await this.initialize();
      
      if (!params || !params.tokenId || typeof params.tokenId !== 'string') {
        throw new Error(`Invalid tokenId: ${params?.tokenId}`);
      }
      const tokenId = params.tokenId;
      let price = Number(params.price);
      const size = Number(params.size);
      
      if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
        throw new Error(`Invalid price (${price}) or size (${size})`);
      }

      let tickSize: TickSize | undefined;
      let negRisk: boolean | undefined;
      
      try {
        tickSize = await this.clobClient!.getTickSize(tokenId);
      } catch (e) {
        // ignore
      }
      
      try {
        negRisk = await this.clobClient!.getNegRisk(tokenId);
      } catch (e) {
        // ignore
      }
      
      const orderType = params.orderType === 'GTD' ? ClobOrderType.GTD : ClobOrderType.GTC;
      price = this.normalizePrice(price, tickSize);

      try {
        const result = await this.clobClient!.createAndPostOrder(
            {
              tokenID: tokenId,
              side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
              price: price,
              size: size,
              expiration: params.expiration || 0,
            },
            { tickSize, negRisk },
            orderType
          );
          
          const ok = !!(result?.orderID);
          const errorMsg = result?.errorMsg != null ? this.normalizeErrorMsg(result?.errorMsg) : (!ok ? 'order_rejected' : undefined);
          return {
            success: ok,
            orderId: result?.orderID,
            transactionHashes: result?.transactionsHashes,
            errorMsg,
            rawStatus: result?.status
          };
      } catch (e: any) {
        return { success: false, errorMsg: this.normalizeErrorMsg(e) };
      }
  }

  async createMarketOrder(params: any): Promise<any> {
      if (!this.clobClient) await this.initialize();

      if (!params || !params.tokenId || typeof params.tokenId !== 'string') {
        throw new Error(`Invalid tokenId: ${params?.tokenId}`);
      }
      const tokenId = params.tokenId;
      const amount = Number(params.amount);
      const side = params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL;

      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Invalid amount (${amount})`);
      }

      const orderType = params.orderType === 'FAK' ? ClobOrderType.FAK : ClobOrderType.FOK;

      let tickSize: TickSize | undefined;
      let negRisk: boolean | undefined;

      try {
        tickSize = await this.clobClient!.getTickSize(tokenId);
      } catch (e) {
        // ignore
      }

      try {
        negRisk = await this.clobClient!.getNegRisk(tokenId);
      } catch (e) {
        // ignore
      }

      try {
        const result = await this.clobClient!.createAndPostMarketOrder(
          {
            tokenID: tokenId,
            side,
            amount,
            price: params.price != null ? this.normalizePrice(Number(params.price), tickSize) : undefined,
          },
          { tickSize, negRisk },
          orderType
        );

        const ok = !!(result?.success) || !!(result?.orderID);
        const errorMsg = result?.errorMsg != null ? this.normalizeErrorMsg(result?.errorMsg) : (!ok ? 'order_rejected' : undefined);
        return {
          success: ok,
          orderId: result?.orderID,
          transactionHashes: result?.transactionsHashes,
          errorMsg
        };
      } catch (e: any) {
        return { success: false, errorMsg: this.normalizeErrorMsg(e) };
      }
  }

  async getOrder(orderId: string): Promise<any> {
      if (!this.clobClient) await this.initialize();
      const o = await this.clobClient!.getOrder(orderId);
      return {
          id: o.id,
          status: o.status,
          tokenId: o.asset_id,
          side: o.side.toUpperCase(),
          price: Number(o.price),
          originalSize: Number(o.original_size),
          filledSize: Number(o.size_matched),
          marketId: o.market,
          outcome: o.outcome,
          createdAt: o.created_at
      };
  }

  async cancelOrder(orderId: string): Promise<any> {
      if (!this.clobClient) await this.initialize();
      return await this.clobClient!.cancelOrder({ orderID: orderId });
  }

  async cancelAll(): Promise<any> {
      if (!this.clobClient) await this.initialize();
      return await this.clobClient!.cancelAll();
  }

  async getTrades(params?: any): Promise<any[]> {
      if (!this.clobClient) await this.initialize();
      return await this.clobClient!.getTrades(params);
  }

  async getOpenOrders(marketId?: string): Promise<any[]> {
      if (!this.clobClient) await this.initialize();
      const orders = await this.clobClient!.getOpenOrders(marketId ? { market: marketId } : undefined);
      return orders.map((o: any) => ({
          id: o.id,
          status: o.status,
          tokenId: o.asset_id,
          side: o.side.toUpperCase(),
          price: Number(o.price),
          originalSize: Number(o.original_size),
          filledSize: Number(o.size_matched),
          marketId: o.market,
          outcome: o.outcome,
          createdAt: o.created_at
      }));
  }
}
