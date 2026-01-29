/**
 * SQL.js Database Service
 * 使用纯 JavaScript/WebAssembly 实现的 SQLite，无需原生编译
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'whales.db');

let db: SqlJsDatabase | null = null;

// 确保数据目录存在
function ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

// 初始化数据库
export async function initDb(): Promise<SqlJsDatabase> {
    if (db) return db;

    ensureDataDir();

    // 初始化 sql.js
    const SQL = await initSqlJs();

    // 如果数据库文件存在，加载它；否则创建新的
    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
        console.log('[DB] Loaded existing database from', DB_PATH);
    } else {
        db = new SQL.Database();
        console.log('[DB] Created new database');
    }

    // 创建表（如果不存在）
    db.run(`
        CREATE TABLE IF NOT EXISTS whales (
            address TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            last_updated INTEGER NOT NULL
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS watched (
            address TEXT PRIMARY KEY,
            added_at INTEGER NOT NULL,
            label TEXT
        )
    `);

    // 添加 label 列（如果不存在）- 兼容旧数据库
    try {
        db.run('ALTER TABLE watched ADD COLUMN label TEXT');
    } catch {
        // 列已存在，忽略
    }

    // 保存初始表结构
    saveDb();

    console.log('[DB] Database initialized');
    return db;
}

// 获取数据库实例
export function getDb(): SqlJsDatabase {
    if (!db) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return db;
}

// 保存数据库到文件
export function saveDb(): void {
    if (!db) return;

    ensureDataDir();
    const data = db.export();
    const buffer = Buffer.from(data);
    // fs.writeFileSync(DB_PATH, buffer);
}

// 关闭数据库
export function closeDb(): void {
    if (db) {
        saveDb();
        db.close();
        db = null;
    }
}

// 清空所有鲸鱼数据
export function clearAllData(): void {
    if (!db) return;
    db.run('DELETE FROM whales');
    db.run('DELETE FROM watched');
    saveDb();
    console.log('[DB] All data cleared');
}

export default { initDb, getDb, saveDb, closeDb, clearAllData };
