/**
 * 显示工具
 */

import chalk from 'chalk';
import Table from 'cli-table3';

// 颜色主题
export const colors = {
    success: chalk.green,
    error: chalk.red,
    warning: chalk.yellow,
    info: chalk.blue,
    muted: chalk.gray,
    highlight: chalk.cyan,
    profit: chalk.green.bold,
    loss: chalk.red.bold,
};

// 打印标题
export function printTitle(title: string) {
    console.log();
    console.log(colors.highlight('═'.repeat(60)));
    console.log(colors.highlight.bold(`  ${title}`));
    console.log(colors.highlight('═'.repeat(60)));
    console.log();
}

// 打印成功消息
export function printSuccess(message: string) {
    console.log(colors.success(`✅ ${message}`));
}

// 打印错误消息
export function printError(message: string) {
    console.log(colors.error(`❌ ${message}`));
}

// 打印警告消息
export function printWarning(message: string) {
    console.log(colors.warning(`⚠️  ${message}`));
}

// 创建表格
export function createTable(headers: string[]): Table.Table {
    return new Table({
        head: headers.map(h => colors.highlight(h)),
        style: {
            head: [],
            border: [],
        },
    });
}

// 格式化价格
export function formatPrice(price: number): string {
    return price.toFixed(4);
}

// 格式化百分比
export function formatPercent(value: number): string {
    const formatted = (value * 100).toFixed(2);
    if (value > 0) {
        return colors.profit(`+${formatted}%`);
    } else if (value < 0) {
        return colors.loss(`${formatted}%`);
    }
    return `${formatted}%`;
}

// 格式化金额
export function formatAmount(amount: number): string {
    if (amount >= 1000000) {
        return `$${(amount / 1000000).toFixed(2)}M`;
    } else if (amount >= 1000) {
        return `$${(amount / 1000).toFixed(1)}K`;
    }
    return `$${amount.toFixed(2)}`;
}

// 截断字符串
export function truncate(str: string, length: number): string {
    if (str.length <= length) return str;
    return str.slice(0, length - 3) + '...';
}
