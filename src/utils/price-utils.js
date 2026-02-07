/**
 * Price Utilities for Polymarket Trading
 *
 * Provides helpers for:
 * - Price validation and rounding to tick size
 * - Size validation
 * - Order amount calculation
 */
// Rounding configuration for each tick size
export const ROUNDING_CONFIG = {
    '0.1': { price: 1, size: 2, amount: 2 },
    '0.01': { price: 2, size: 2, amount: 4 },
    '0.001': { price: 3, size: 2, amount: 5 },
    '0.0001': { price: 4, size: 2, amount: 6 },
};
/**
 * Round a price to the appropriate tick size
 *
 * @param price - The price to round (0 to 1)
 * @param tickSize - The tick size for the market
 * @param direction - 'floor' for sells, 'ceil' for buys, 'round' for midpoint
 * @returns Rounded price
 *
 * @example
 * roundPrice(0.523, '0.01', 'floor') // 0.52
 * roundPrice(0.523, '0.01', 'ceil') // 0.53
 */
export function roundPrice(price, tickSize, direction = 'round') {
    const decimals = ROUNDING_CONFIG[tickSize].price;
    const multiplier = Math.pow(10, decimals);
    let rounded;
    switch (direction) {
        case 'floor':
            rounded = Math.floor(price * multiplier) / multiplier;
            break;
        case 'ceil':
            rounded = Math.ceil(price * multiplier) / multiplier;
            break;
        default:
            rounded = Math.round(price * multiplier) / multiplier;
    }
    // Clamp to valid price range
    return Math.max(0.001, Math.min(0.999, rounded));
}
/**
 * Round a size to valid decimals (always 2 decimal places)
 */
export function roundSize(size) {
    return Math.round(size * 100) / 100;
}
/**
 * Validate a price is within valid range and tick size
 *
 * @param price - The price to validate
 * @param tickSize - The tick size for the market
 * @returns Validation result with error message if invalid
 */
export function validatePrice(price, tickSize) {
    // Check range
    if (price < 0.001 || price > 0.999) {
        return { valid: false, error: 'Price must be between 0.001 and 0.999' };
    }
    // Check tick size alignment
    const decimals = ROUNDING_CONFIG[tickSize].price;
    const multiplier = Math.pow(10, decimals);
    const rounded = Math.round(price * multiplier) / multiplier;
    if (Math.abs(price - rounded) > 1e-10) {
        return {
            valid: false,
            error: `Price ${price} does not align with tick size ${tickSize}. Use ${rounded} instead.`,
        };
    }
    return { valid: true };
}
/**
 * Validate minimum size requirements
 *
 * @param size - The size to validate
 * @param minOrderSize - Minimum order size from market config (usually 0.1)
 */
export function validateSize(size, minOrderSize = 0.1) {
    if (size < minOrderSize) {
        return {
            valid: false,
            error: `Size ${size} is below minimum order size ${minOrderSize}`,
        };
    }
    return { valid: true };
}
/**
 * Calculate the amount needed for a buy order (in USDC)
 *
 * @param price - Price per share
 * @param size - Number of shares to buy
 * @returns Amount in USDC
 */
export function calculateBuyAmount(price, size) {
    return price * size;
}
/**
 * Calculate the payout for a sell order (in USDC)
 *
 * @param price - Price per share
 * @param size - Number of shares to sell
 * @returns Amount in USDC
 */
export function calculateSellPayout(price, size) {
    return price * size;
}
/**
 * Calculate number of shares that can be bought with a given amount
 *
 * @param amount - USDC amount to spend
 * @param price - Price per share
 * @returns Number of shares
 */
export function calculateSharesForAmount(amount, price) {
    return roundSize(amount / price);
}
/**
 * Calculate the spread between bid and ask
 *
 * @param bid - Highest bid price
 * @param ask - Lowest ask price
 * @returns Spread as a decimal (0 to 1)
 */
export function calculateSpread(bid, ask) {
    return ask - bid;
}
/**
 * Calculate the midpoint price between bid and ask
 *
 * @param bid - Highest bid price
 * @param ask - Lowest ask price
 * @returns Midpoint price
 */
export function calculateMidpoint(bid, ask) {
    return (bid + ask) / 2;
}
/**
 * 计算有效价格（考虑 Polymarket 订单簿的镜像特性）
 *
 * Polymarket 的关键特性：买 YES @ P = 卖 NO @ (1-P)
 * 因此同一订单会在两个订单簿中出现
 *
 * 有效价格是考虑镜像后的最优价格
 *
 * @param yesAsk - YES token 的最低卖价
 * @param yesBid - YES token 的最高买价
 * @param noAsk - NO token 的最低卖价
 * @param noBid - NO token 的最高买价
 */
export function getEffectivePrices(yesAsk, yesBid, noAsk, noBid) {
    return {
        // 买 YES: 直接买 YES.ask 或 通过卖 NO (成本 = 1 - NO.bid)
        effectiveBuyYes: Math.min(yesAsk, 1 - noBid),
        // 买 NO: 直接买 NO.ask 或 通过卖 YES (成本 = 1 - YES.bid)
        effectiveBuyNo: Math.min(noAsk, 1 - yesBid),
        // 卖 YES: 直接卖 YES.bid 或 通过买 NO (收入 = 1 - NO.ask)
        effectiveSellYes: Math.max(yesBid, 1 - noAsk),
        // 卖 NO: 直接卖 NO.bid 或 通过买 YES (收入 = 1 - YES.ask)
        effectiveSellNo: Math.max(noBid, 1 - yesAsk),
    };
}
/**
 * Check if there's an arbitrage opportunity
 *
 * 使用有效价格计算套利机会（正确考虑镜像订单）
 *
 * Long arb: Buy YES + Buy NO < 1 (使用有效买入价格)
 * Short arb: Sell YES + Sell NO > 1 (使用有效卖出价格)
 *
 * 详细文档见: docs/01-polymarket-orderbook-arbitrage.md
 *
 * @param yesAsk - Lowest ask for YES token
 * @param noAsk - Lowest ask for NO token
 * @param yesBid - Highest bid for YES token
 * @param noBid - Highest bid for NO token
 * @returns Arbitrage info or null
 */
export function checkArbitrage(yesAsk, noAsk, yesBid, noBid) {
    // 计算有效价格
    const effective = getEffectivePrices(yesAsk, yesBid, noAsk, noBid);
    // Long arbitrage: Buy complete set (YES + NO) cheaper than $1
    const effectiveLongCost = effective.effectiveBuyYes + effective.effectiveBuyNo;
    const longProfit = 1 - effectiveLongCost;
    // Short arbitrage: Sell complete set (YES + NO) for more than $1
    const effectiveShortRevenue = effective.effectiveSellYes + effective.effectiveSellNo;
    const shortProfit = effectiveShortRevenue - 1;
    const naiveLongProfit = 1 - (yesAsk + noAsk);
    const naiveShortProfit = (yesBid + noBid) - 1;
    if (naiveLongProfit > 0 || naiveShortProfit > 0) {
        if (naiveShortProfit > naiveLongProfit) {
            return {
                type: 'short',
                profit: shortProfit,
                description: `Split $1, Sell YES @ ${effective.effectiveSellYes.toFixed(4)} + NO @ ${effective.effectiveSellNo.toFixed(4)}`,
            };
        }
        return {
            type: 'long',
            profit: longProfit,
            description: `Buy YES @ ${effective.effectiveBuyYes.toFixed(4)} + NO @ ${effective.effectiveBuyNo.toFixed(4)}, Merge for $1`,
        };
    }
    if (longProfit > 0 || shortProfit > 0) {
        if (shortProfit > longProfit) {
            return {
                type: 'short',
                profit: shortProfit,
                description: `Split $1, Sell YES @ ${effective.effectiveSellYes.toFixed(4)} + NO @ ${effective.effectiveSellNo.toFixed(4)}`,
            };
        }
        return {
            type: 'long',
            profit: longProfit,
            description: `Buy YES @ ${effective.effectiveBuyYes.toFixed(4)} + NO @ ${effective.effectiveBuyNo.toFixed(4)}, Merge for $1`,
        };
    }
    return null;
}
/**
 * Format price for display
 */
export function formatPrice(price, tickSize) {
    const decimals = tickSize ? ROUNDING_CONFIG[tickSize].price : 4;
    return price.toFixed(decimals);
}
/**
 * Format amount in USDC
 */
export function formatUSDC(amount) {
    return `$${amount.toFixed(2)}`;
}
/**
 * Calculate PnL for a position
 *
 * @param entryPrice - Average entry price
 * @param currentPrice - Current market price
 * @param size - Position size
 * @param side - 'long' for YES, 'short' for NO
 */
export function calculatePnL(entryPrice, currentPrice, size, side = 'long') {
    const pnl = side === 'long'
        ? (currentPrice - entryPrice) * size
        : (entryPrice - currentPrice) * size;
    const pnlPercent = side === 'long'
        ? ((currentPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - currentPrice) / entryPrice) * 100;
    return { pnl, pnlPercent };
}
