/**
 * 监控命令
 */

import { Command } from 'commander';
import ora from 'ora';
import { PolymarketSDK, checkArbitrage } from '../../../src/index.js';
import {
    printTitle,
    printSuccess,
    printError,
    formatPrice,
    formatPercent,
    colors,
} from '../utils/display.js';

const sdk = new PolymarketSDK();

export const monitorCommand = new Command('monitor')
    .description('实时监控');

// 监控市场
monitorCommand
    .command('market <conditionId>')
    .description('监控市场实时数据')
    .option('-i, --interval <number>', '刷新间隔（秒）', '5')
    .action(async (conditionId, options) => {
        printTitle('📡 实时监控');

        const interval = parseInt(options.interval) * 1000;

        console.log(`市场: ${conditionId}`);
        console.log(`刷新间隔: ${interval / 1000} 秒`);
        console.log('按 Ctrl+C 停止');
        console.log();

        let running = true;

        process.on('SIGINT', () => {
            running = false;
            console.log('\n监控已停止');
            process.exit(0);
        });

        while (running) {
            try {
                const orderbook = await sdk.getOrderbook(conditionId);
                const arb = checkArbitrage(
                    orderbook.yes.ask,
                    orderbook.no.ask,
                    orderbook.yes.bid,
                    orderbook.no.bid
                );

                // 清屏并显示数据
                process.stdout.write('\x1B[2J\x1B[0f');

                printTitle('📡 实时监控');
                console.log(`时间: ${new Date().toLocaleTimeString()}`);
                console.log();
                console.log('价格:');
                console.log(`  YES: Bid ${formatPrice(orderbook.yes.bid)} | Ask ${formatPrice(orderbook.yes.ask)}`);
                console.log(`  NO:  Bid ${formatPrice(orderbook.no.bid)} | Ask ${formatPrice(orderbook.no.ask)}`);
                console.log();
                console.log('套利:');
                console.log(`  多头利润: ${formatPercent(orderbook.summary.longArbProfit)}`);
                console.log(`  空头利润: ${formatPercent(orderbook.summary.shortArbProfit)}`);

                if (arb) {
                    console.log();
                    console.log(colors.profit(`🎯 发现套利机会: ${arb.type} +${(arb.profit * 100).toFixed(2)}%`));
                    console.log(`   ${arb.description}`);
                }

                console.log();
                console.log('按 Ctrl+C 停止');

            } catch (error) {
                printError((error as Error).message);
            }

            await new Promise(resolve => setTimeout(resolve, interval));
        }
    });

// 扫描监控
monitorCommand
    .command('scan')
    .description('持续扫描套利机会')
    .option('-i, --interval <number>', '扫描间隔（秒）', '10')
    .option('-m, --min-profit <number>', '最小利润百分比', '0.5')
    .action(async (options) => {
        printTitle('🔄 套利扫描器');

        const interval = parseInt(options.interval) * 1000;
        const minProfit = parseFloat(options.minProfit) / 100;

        console.log(`扫描间隔: ${interval / 1000} 秒`);
        console.log(`最小利润: ${(minProfit * 100).toFixed(1)}%`);
        console.log('按 Ctrl+C 停止');
        console.log();

        let running = true;
        let scanCount = 0;
        let totalOpportunities = 0;

        process.on('SIGINT', () => {
            running = false;
            console.log(`\n\n扫描统计: ${scanCount} 次扫描, ${totalOpportunities} 个机会`);
            process.exit(0);
        });

        while (running) {
            scanCount++;
            const spinner = ora(`扫描 #${scanCount}...`).start();

            try {
                const markets = await sdk.gammaApi.getMarkets({
                    closed: false,
                    active: true,
                    limit: 30,
                });

                let found = 0;

                for (const market of markets) {
                    if (!market.conditionId) continue;

                    try {
                        const orderbook = await sdk.clobApi.getProcessedOrderbook(market.conditionId);
                        const arb = checkArbitrage(
                            orderbook.yes.ask,
                            orderbook.no.ask,
                            orderbook.yes.bid,
                            orderbook.no.bid
                        );

                        if (arb && arb.profit > minProfit) {
                            found++;
                            totalOpportunities++;

                            spinner.stop();
                            console.log(colors.profit(`\n🎯 [${new Date().toLocaleTimeString()}] ${arb.type.toUpperCase()} +${(arb.profit * 100).toFixed(2)}%`));
                            console.log(`   ${market.question?.slice(0, 50)}...`);
                            console.log(`   ${arb.description}`);
                            spinner.start(`扫描 #${scanCount}...`);
                        }
                    } catch (error) {
                        // 跳过
                    }
                }

                if (found === 0) {
                    spinner.info(`扫描 #${scanCount} 完成，无新机会`);
                } else {
                    spinner.succeed(`扫描 #${scanCount} 完成，发现 ${found} 个机会`);
                }

            } catch (error) {
                spinner.fail((error as Error).message);
            }

            await new Promise(resolve => setTimeout(resolve, interval));
        }
    });
