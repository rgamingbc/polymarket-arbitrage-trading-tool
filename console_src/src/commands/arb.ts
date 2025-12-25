/**
 * 套利命令
 */

import { Command } from 'commander';
import ora from 'ora';
import { PolymarketSDK, checkArbitrage } from '../../../src/index.js';
import {
    printTitle,
    printSuccess,
    printError,
    printWarning,
    createTable,
    formatPrice,
    formatPercent,
    formatAmount,
    truncate,
    colors,
} from '../utils/display.js';

const sdk = new PolymarketSDK();

export const arbCommand = new Command('arb')
    .description('套利相关命令');

// 扫描套利机会
arbCommand
    .command('scan')
    .description('扫描套利机会')
    .option('-l, --limit <number>', '扫描市场数量', '50')
    .option('-m, --min-profit <number>', '最小利润百分比', '0.3')
    .option('-v, --min-volume <number>', '最小 24h 交易量', '5000')
    .action(async (options) => {
        printTitle('🔍 套利扫描');

        const spinner = ora('获取市场列表...').start();

        try {
            const limit = parseInt(options.limit);
            const minProfit = parseFloat(options.minProfit) / 100;
            const minVolume = parseInt(options.minVolume);

            const markets = await sdk.gammaApi.getMarkets({
                closed: false,
                active: true,
                limit,
            });

            spinner.text = `分析 ${markets.length} 个市场...`;

            const opportunities = [];
            let analyzed = 0;

            for (const market of markets) {
                if (!market.conditionId) continue;
                if ((market.volume24hr || 0) < minVolume) continue;

                analyzed++;
                spinner.text = `分析中... ${analyzed}/${markets.length}`;

                try {
                    const orderbook = await sdk.clobApi.getProcessedOrderbook(market.conditionId);
                    const arb = checkArbitrage(
                        orderbook.yes.ask,
                        orderbook.no.ask,
                        orderbook.yes.bid,
                        orderbook.no.bid
                    );

                    if (arb && arb.profit > minProfit) {
                        opportunities.push({
                            market,
                            arb,
                            orderbook,
                        });
                    }
                } catch (error) {
                    // 跳过
                }
            }

            spinner.succeed(`扫描完成，分析了 ${analyzed} 个市场`);

            if (opportunities.length === 0) {
                printWarning(`未发现利润超过 ${(minProfit * 100).toFixed(1)}% 的套利机会`);
                return;
            }

            // 按利润排序
            opportunities.sort((a, b) => b.arb.profit - a.arb.profit);

            printSuccess(`发现 ${opportunities.length} 个套利机会:`);
            console.log();

            const table = createTable(['类型', '市场', '利润', '24h量', 'YES Ask', 'NO Ask']);

            for (const opp of opportunities.slice(0, 10)) {
                const typeStr = opp.arb.type === 'long'
                    ? colors.profit('多头')
                    : colors.warning('空头');

                table.push([
                    typeStr,
                    truncate(opp.market.question || '', 30),
                    formatPercent(opp.arb.profit),
                    formatAmount(opp.market.volume24hr || 0),
                    formatPrice(opp.orderbook.yes.ask),
                    formatPrice(opp.orderbook.no.ask),
                ]);
            }

            console.log(table.toString());
        } catch (error) {
            spinner.fail('扫描失败');
            printError((error as Error).message);
        }
    });

// 检测特定市场套利
arbCommand
    .command('check <conditionId>')
    .description('检测特定市场套利')
    .action(async (conditionId) => {
        printTitle('💰 套利检测');

        const spinner = ora('分析市场...').start();

        try {
            const arb = await sdk.detectArbitrage(conditionId);

            if (arb) {
                spinner.succeed('发现套利机会!');
                console.log();
                console.log(`类型: ${arb.type === 'long' ? '多头套利' : '空头套利'}`);
                console.log(`利润: ${formatPercent(arb.profit)}`);
                console.log(`操作: ${arb.action}`);
                console.log(`描述: ${arb.description}`);
            } else {
                spinner.info('无套利机会');
            }
        } catch (error) {
            spinner.fail('检测失败');
            printError((error as Error).message);
        }
    });
