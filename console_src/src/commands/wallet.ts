/**
 * 钱包命令
 */

import { Command } from 'commander';
import ora from 'ora';
import { PolymarketSDK } from '../../../src/index.js';
import {
    printTitle,
    printSuccess,
    printError,
    createTable,
    formatAmount,
    formatPercent,
    truncate,
} from '../utils/display.js';

const sdk = new PolymarketSDK();

export const walletCommand = new Command('wallet')
    .description('钱包相关命令');

// 查看排行榜
walletCommand
    .command('leaderboard')
    .description('查看交易员排行榜')
    .option('-l, --limit <number>', '数量限制', '10')
    .action(async (options) => {
        printTitle('🏆 交易员排行榜');

        const spinner = ora('获取排行榜...').start();

        try {
            const limit = parseInt(options.limit);
            const traders = await sdk.wallets.getTopTraders(limit);

            spinner.succeed(`找到 ${traders.length} 名交易员`);

            const table = createTable(['排名', '地址', '盈亏', '交易量']);

            for (const trader of traders) {
                table.push([
                    `#${trader.rank}`,
                    truncate(trader.address, 12),
                    formatAmount(trader.pnl),
                    formatAmount(trader.volume),
                ]);
            }

            console.log(table.toString());
        } catch (error) {
            spinner.fail('获取失败');
            printError((error as Error).message);
        }
    });

// 查看钱包画像
walletCommand
    .command('profile <address>')
    .description('查看钱包画像')
    .action(async (address) => {
        printTitle('👤 钱包画像');

        const spinner = ora('获取钱包信息...').start();

        try {
            const profile = await sdk.wallets.getWalletProfile(address);

            spinner.succeed('获取成功');

            console.log(`地址: ${profile.address}`);
            console.log(`聪明分数: ${profile.smartScore}/100`);
            console.log();
            console.log(`总盈亏: ${formatAmount(profile.totalPnL)}`);
            console.log(`持仓数: ${profile.positionCount}`);
            console.log(`最后活跃: ${profile.lastActiveAt.toLocaleString()}`);
        } catch (error) {
            spinner.fail('获取失败');
            printError((error as Error).message);
        }
    });

// 查看持仓
walletCommand
    .command('positions <address>')
    .description('查看钱包持仓')
    .option('-l, --limit <number>', '数量限制', '10')
    .action(async (address, options) => {
        printTitle('📊 钱包持仓');

        const spinner = ora('获取持仓...').start();

        try {
            const positions = await sdk.dataApi.getPositions(address);

            spinner.succeed(`找到 ${positions.length} 个持仓`);

            const table = createTable(['市场', '方向', '数量', '均价', '当前价', '盈亏']);

            const limit = parseInt(options.limit);
            for (const pos of positions.slice(0, limit)) {
                const pnl = pos.cashPnl || 0;
                table.push([
                    truncate(pos.title || '', 25),
                    pos.outcome || 'N/A',
                    pos.size.toFixed(2),
                    formatAmount(pos.avgPrice || 0),
                    formatAmount(pos.curPrice || 0),
                    formatPercent(pnl / 100),
                ]);
            }

            console.log(table.toString());

            if (positions.length > limit) {
                console.log(`\n还有 ${positions.length - limit} 个持仓未显示`);
            }
        } catch (error) {
            spinner.fail('获取失败');
            printError((error as Error).message);
        }
    });
