/**
 * 市场命令
 */

import { Command } from 'commander';
import ora from 'ora';
import { PolymarketSDK } from '../../../src/index.js';
import {
    printTitle,
    printSuccess,
    printError,
    createTable,
    formatPrice,
    formatAmount,
    truncate,
} from '../utils/display.js';

const sdk = new PolymarketSDK();

export const marketsCommand = new Command('markets')
    .description('市场相关命令');

// 列出热门市场
marketsCommand
    .command('list')
    .description('列出热门市场')
    .option('-l, --limit <number>', '数量限制', '10')
    .action(async (options) => {
        printTitle('🔥 热门市场');

        const spinner = ora('获取热门市场...').start();

        try {
            const limit = parseInt(options.limit);
            const markets = await sdk.gammaApi.getTrendingMarkets(limit);

            spinner.succeed(`找到 ${markets.length} 个市场`);

            const table = createTable(['#', '市场', '24h 交易量', 'YES', 'NO']);

            for (let i = 0; i < markets.length; i++) {
                const m = markets[i];
                table.push([
                    (i + 1).toString(),
                    truncate(m.question || '', 40),
                    formatAmount(m.volume24hr || 0),
                    formatPrice(m.outcomePrices?.[0] || 0),
                    formatPrice(m.outcomePrices?.[1] || 0),
                ]);
            }

            console.log(table.toString());
        } catch (error) {
            spinner.fail('获取失败');
            printError((error as Error).message);
        }
    });

// 查看市场详情
marketsCommand
    .command('info <conditionId>')
    .description('查看市场详情')
    .action(async (conditionId) => {
        printTitle('📊 市场详情');

        const spinner = ora('获取市场信息...').start();

        try {
            const market = await sdk.getMarket(conditionId);
            spinner.succeed('获取成功');

            console.log(`问题: ${market.question}`);
            console.log(`状态: ${market.active ? '活跃' : '已关闭'}`);
            console.log();
            console.log(`YES 价格: ${formatPrice(market.tokens.yes.price)}`);
            console.log(`NO 价格:  ${formatPrice(market.tokens.no.price)}`);
            console.log();
            console.log(`24h 交易量: ${formatAmount(market.volume24hr || 0)}`);
            console.log(`Condition ID: ${conditionId}`);
        } catch (error) {
            spinner.fail('获取失败');
            printError((error as Error).message);
        }
    });

// 查看订单簿
marketsCommand
    .command('orderbook <conditionId>')
    .description('查看订单簿')
    .action(async (conditionId) => {
        printTitle('📖 订单簿');

        const spinner = ora('获取订单簿...').start();

        try {
            const orderbook = await sdk.getOrderbook(conditionId);
            spinner.succeed('获取成功');

            console.log('YES 代币:');
            console.log(`  买价 (Bid): ${formatPrice(orderbook.yes.bid)}`);
            console.log(`  卖价 (Ask): ${formatPrice(orderbook.yes.ask)}`);
            console.log(`  价差: ${((orderbook.yes.ask - orderbook.yes.bid) * 100).toFixed(2)}%`);
            console.log();
            console.log('NO 代币:');
            console.log(`  买价 (Bid): ${formatPrice(orderbook.no.bid)}`);
            console.log(`  卖价 (Ask): ${formatPrice(orderbook.no.ask)}`);
            console.log(`  价差: ${((orderbook.no.ask - orderbook.no.bid) * 100).toFixed(2)}%`);
            console.log();
            console.log('套利分析:');
            console.log(`  多头成本: ${formatPrice(orderbook.summary.effectiveLongCost)}`);
            console.log(`  空头收益: ${formatPrice(orderbook.summary.effectiveShortRevenue)}`);
            console.log(`  多头利润: ${(orderbook.summary.longArbProfit * 100).toFixed(2)}%`);
            console.log(`  空头利润: ${(orderbook.summary.shortArbProfit * 100).toFixed(2)}%`);
        } catch (error) {
            spinner.fail('获取失败');
            printError((error as Error).message);
        }
    });
