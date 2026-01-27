import time
import requests
from typing import Dict, Any, List
from datetime import datetime
import db

DATA_API_BASE = "https://data-api.polymarket.com"

def _get(url: str, params: Dict[str, Any]) -> requests.Response:
    return requests.get(url, params=params, timeout=20)

def fetch_trades_for_user(address: str) -> List[Dict[str, Any]]:
    url = f"{DATA_API_BASE}/trades"
    params = {"user": address}
    r = _get(url, params)
    if r.status_code != 200 or not isinstance(r.json(), list) or len(r.json()) == 0:
        params = {"proxyWallet": address}
        r = _get(url, params)
    if r.status_code != 200:
        return []
    data = r.json()
    if not isinstance(data, list):
        return []
    return data

def fetch_activity_for_user(address: str) -> List[Dict[str, Any]]:
    url = f"{DATA_API_BASE}/activity"
    params = {"user": address}
    r = _get(url, params)
    if r.status_code != 200 or not isinstance(r.json(), list) or len(r.json()) == 0:
        params = {"proxyWallet": address}
        r = _get(url, params)
    if r.status_code != 200:
        return []
    data = r.json()
    if not isinstance(data, list):
        return []
    return data

def update_trader_profile(address: str, sample: Dict[str, Any]) -> None:
    def normalize_image(u: Any) -> Any:
        if not u or not isinstance(u, str):
            return u
        if u.startswith("ipfs://"):
            h = u.replace("ipfs://", "").strip()
            return f"https://cloudflare-ipfs.com/ipfs/{h}"
        return u
    info = {
        "name": sample.get("name"),
        "pseudonym": sample.get("pseudonym"),
        "bio": sample.get("bio"),
        "profile_image": normalize_image(sample.get("profileImageOptimized") or sample.get("profileImage")),
        "last_seen": sample.get("timestamp") or int(datetime.utcnow().timestamp()),
    }
    db.update_trader_info(address, info)

def run_once() -> None:
    traders = db.list_traders()
    for t in traders:
        address = t["address"]
        activity = fetch_activity_for_user(address)
        if len(activity) > 0:
            update_trader_profile(address, activity[0])
            for item in activity:
                if item.get("type") == "TRADE":
                    db.add_trade(item)
        else:
            trades = fetch_trades_for_user(address)
            if len(trades) > 0:
                update_trader_profile(address, trades[0])
                for trade in trades:
                    db.add_trade(trade)

def main() -> None:
    db.init_db()
    while True:
        try:
            run_once()
        except Exception:
            pass
        time.sleep(60)

if __name__ == "__main__":
    main()
