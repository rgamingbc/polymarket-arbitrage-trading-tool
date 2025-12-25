/**
 * CLI 入口
 */

import { Command } from 'commander';
import { marketsCommand } from './commands/markets.js';
import { arbCommand } from './commands/arb.js';
import { walletCommand } from './commands/wallet.js';
import { monitorCommand } from './commands/monitor.js';

const program = new Command();

program
    .name('poly')
    .description('Polymarket 控制台工具')
    .version('1.0.0');

// 注册命令
program.addCommand(marketsCommand);
program.addCommand(arbCommand);
program.addCommand(walletCommand);
program.addCommand(monitorCommand);

program.parse();
