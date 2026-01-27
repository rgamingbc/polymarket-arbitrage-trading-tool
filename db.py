import os
import sqlite3
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "polymarket.db")

def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db() -> None:
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS tracked_traders (
            address TEXT PRIMARY KEY,
            name TEXT,
            pseudonym TEXT,
            bio TEXT,
            profile_image TEXT,
            last_seen INTEGER,
            created_at INTEGER
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_hash TEXT UNIQUE,
            proxy_wallet TEXT,
            condition_id TEXT,
            type TEXT,
            side TEXT,
            size REAL,
            usdc_size REAL,
            price REAL,
            asset TEXT,
            outcome_index INTEGER,
            title TEXT,
            slug TEXT,
            icon TEXT,
            event_slug TEXT,
            outcome TEXT,
            timestamp INTEGER,
            inserted_at INTEGER
        )
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_trades_wallet_time
        ON trades (proxy_wallet, timestamp DESC)
        """
    )
    conn.commit()
    conn.close()

def add_trader(address: str) -> None:
    now = int(datetime.utcnow().timestamp())
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT OR IGNORE INTO tracked_traders (address, created_at)
        VALUES (?, ?)
        """,
        (address.lower(), now),
    )
    conn.commit()
    conn.close()

def update_trader_info(address: str, info: Dict[str, Any]) -> None:
    fields = []
    values: List[Any] = []
    for k in ["name", "pseudonym", "bio", "profile_image", "last_seen"]:
        if k in info and info[k] is not None:
            fields.append(f"{k} = ?")
            values.append(info[k])
    if not fields:
        return
    values.append(address.lower())
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        f"UPDATE tracked_traders SET {', '.join(fields)} WHERE address = ?",
        values,
    )
    conn.commit()
    conn.close()

def list_traders() -> List[Dict[str, Any]]:
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM tracked_traders ORDER BY created_at DESC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def add_trade(trade: Dict[str, Any]) -> None:
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT OR IGNORE INTO trades (
            transaction_hash,
            proxy_wallet,
            condition_id,
            type,
            side,
            size,
            usdc_size,
            price,
            asset,
            outcome_index,
            title,
            slug,
            icon,
            event_slug,
            outcome,
            timestamp,
            inserted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            trade.get("transactionHash"),
            trade.get("proxyWallet"),
            trade.get("conditionId"),
            trade.get("type"),
            trade.get("side"),
            trade.get("size"),
            trade.get("usdcSize"),
            trade.get("price"),
            trade.get("asset"),
            trade.get("outcomeIndex"),
            trade.get("title"),
            trade.get("slug"),
            trade.get("icon"),
            trade.get("eventSlug"),
            trade.get("outcome"),
            trade.get("timestamp"),
            int(datetime.utcnow().timestamp()),
        ),
    )
    conn.commit()
    conn.close()

def get_trades_for_trader(address: str, limit: int = 200) -> List[Dict[str, Any]]:
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT * FROM trades
        WHERE proxy_wallet = ?
        ORDER BY timestamp DESC
        LIMIT ?
        """,
        (address.lower(), limit),
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def get_recent_trades(limit: int = 200) -> List[Dict[str, Any]]:
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT t.*, tr.name, tr.pseudonym, tr.profile_image, tr.address
        FROM trades t
        LEFT JOIN tracked_traders tr
        ON LOWER(t.proxy_wallet) = LOWER(tr.address)
        ORDER BY t.timestamp DESC
        LIMIT ?
        """,
        (limit,),
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def get_trader_stats() -> Dict[str, Dict[str, Any]]:
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT proxy_wallet AS address, COUNT(*) AS trades_count, MAX(timestamp) AS last_ts
        FROM trades
        GROUP BY proxy_wallet
        """
    )
    rows = cur.fetchall()
    conn.close()
    stats: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        d = dict(r)
        stats[(d.get("address") or "").lower()] = {
            "trades_count": d.get("trades_count"),
            "last_ts": d.get("last_ts"),
        }
    return stats
