import os

SERVICES_DIR = "../services"

def create_file(filename, content):
    path = os.path.join(SERVICES_DIR, filename)
    with open(path, "w") as f:
        f.write(content)
    print(f"Created {path}")

def main():
    if not os.path.exists(SERVICES_DIR):
        os.makedirs(SERVICES_DIR)

    # 1. utils.py
    create_file("utils.py", '''import time
from functools import wraps
import threading

class RateLimiter:
    def __init__(self, limit=5, window=1):
        self.limit = limit
        self.window = window
        self.calls = []
        self.lock = threading.Lock()

    def allow(self):
        with self.lock:
            now = time.time()
            self.calls = [t for t in self.calls if t > now - self.window]
            if len(self.calls) >= self.limit:
                return False
            self.calls.append(now)
            return True

api_limiter = RateLimiter(limit=10, window=1)

def rate_limit(limiter=api_limiter):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            if not limiter.allow():
                print(f"Rate limit hit for {func.__name__}")
                return None # Or raise exception
            return func(*args, **kwargs)
        return wrapper
    return decorator
''')

    # 2. wallet_service.py
    create_file("wallet_service.py", '''import requests
from eth_account import Account
import traceback
import db
from services.utils import rate_limit

class WalletService:
    USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
    USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
    CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
    RPC_URL = "https://polygon-rpc.com"

    @staticmethod
    def _get_matic_balance(address: str) -> float:
        try:
            payload = {
                "jsonrpc": "2.0", "method": "eth_getBalance",
                "params": [address, "latest"], "id": 1
            }
            r = requests.post(WalletService.RPC_URL, json=payload, timeout=5)
            if r.status_code == 200:
                res = r.json().get("result")
                if res:
                    return int(res, 16) / 1e18
        except:
            pass
        return 0.0

    @staticmethod
    def _erc20_allowance(owner: str, spender: str, token: str) -> float:
        try:
            selector = "0xdd62ed3e"
            p_owner = owner.replace("0x", "").rjust(64, "0")
            p_spender = spender.replace("0x", "").rjust(64, "0")
            data = selector + p_owner + p_spender
            payload = {
                "jsonrpc": "2.0", "method": "eth_call",
                "params": [{"to": token, "data": data}, "latest"], "id": 1
            }
            r = requests.post(WalletService.RPC_URL, json=payload, timeout=5)
            if r.status_code == 200:
                res = r.json().get("result")
                if res:
                    return float(int(res, 16)) / 1_000_000.0
        except:
            pass
        return 0.0

    @staticmethod
    def _erc20_balance(address: str, token: str) -> float:
        try:
            addr = (address or "").strip().lower()
            if not addr.startswith("0x") or len(addr) != 42: return 0.0
            selector = "0x70a08231"
            padded = addr.replace("0x", "").rjust(64, "0")
            data = selector + padded
            payload = {
                "jsonrpc": "2.0", "method": "eth_call",
                "params": [{"to": token, "data": data}, "latest"], "id": 1
            }
            r = requests.post(WalletService.RPC_URL, json=payload, timeout=5)
            if r.status_code == 200:
                res = r.json().get("result")
                if res:
                    return float(int(res, 16)) / 1_000_000.0
        except:
            pass
        return 0.0

    @staticmethod
    def detect_proxy(address):
        try:
            r = requests.get(f"https://data-api.polymarket.com/activity", params={"user": address, "limit": 1}, timeout=5)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list) and len(data) > 0:
                    proxy = data[0].get("proxyWallet")
                    if proxy and proxy.lower() != address.lower():
                        return proxy
        except:
            pass
        return None

    @staticmethod
    def get_balances(pk, funder, sig_type, client_func):
        cash = 0.0
        try:
            client = client_func(pk, sig_type, funder)
            try:
                from py_clob_client.clob_types import BalanceAllowanceParams, AssetType
                params = BalanceAllowanceParams(asset_type=AssetType.COLLATERAL, signature_type=sig_type)
                res = client.get_balance_allowance(params)
                if res and isinstance(res, dict):
                    cash = float(res.get("balance") or 0)
            except:
                bals = client.get_balance()
                if isinstance(bals, list):
                    for b in bals:
                        if b.get("asset_type") == "COLLATERAL":
                            cash = float(b.get("balance") or 0)
                            break
        except Exception as e:
            print(f"ClobClient balance check failed: {e}")

        cash_usdc_e = WalletService._erc20_balance(funder, WalletService.USDC_E)
        if cash == 0 and cash_usdc_e > 0:
            cash = cash_usdc_e
        
        cash_usdc_native = WalletService._erc20_balance(funder, WalletService.USDC_NATIVE)
        allowance = WalletService._erc20_allowance(funder, WalletService.CTF_EXCHANGE, WalletService.USDC_E)
        matic = WalletService._get_matic_balance(funder)
        
        return {
            "cash": cash,
            "usdc_native": cash_usdc_native,
            "matic": matic,
            "allowance": allowance,
            "funder": funder,
            "signature_type": sig_type
        }
''')

    # 3. market_service.py
    create_file("market_service.py", '''import requests
import json
import traceback

class MarketService:
    @staticmethod
    def get_market_by_slug(slug: str):
        try:
            r = requests.get("https://gamma-api.polymarket.com/markets", params={"slug": slug}, timeout=20)
            if r.status_code != 200: return None
            arr = r.json()
            if not isinstance(arr, list) or len(arr) == 0: return None
            return arr[0]
        except:
            return None

    @staticmethod
    def resolve_token_id(slug: str, outcome_index=None, outcome=None):
        m = MarketService.get_market_by_slug(slug)
        if not m: return None
        tokens = m.get("clobTokenIds")
        outs = m.get("outcomes")
        idx = None
        
        if isinstance(outcome_index, int):
            idx = outcome_index
        else:
            if isinstance(outs, str): outs = json.loads(outs)
            if isinstance(outs, list) and outcome is not None:
                for i, o in enumerate(outs):
                    if str(o).strip().lower() == str(outcome).strip().lower():
                        idx = i
                        break
        
        if idx is None: return None
        if isinstance(tokens, str): tokens = json.loads(tokens)
        if not isinstance(tokens, list) or idx >= len(tokens): return None
        return tokens[idx]
''')

    # 4. trade_service.py
    create_file("trade_service.py", '''from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType, MarketOrderArgs
from py_clob_client.order_builder.constants import BUY, SELL
import traceback

class TradeService:
    @staticmethod
    def get_client(pk, sig_type=0, funder=None):
        try:
            l1_client = ClobClient(host="https://clob.polymarket.com", chain_id=137, key=pk)
            creds = l1_client.create_or_derive_api_creds()
            client = ClobClient(
                host="https://clob.polymarket.com",
                chain_id=137,
                key=pk,
                creds=creds,
                signature_type=sig_type,
                funder=funder
            )
            return client
        except Exception as e:
            print(f"Error creating ClobClient: {e}")
            raise e

    @staticmethod
    def place_order(client, token_id, side, size=None, price=None, usdc_amount=None):
        try:
            sgn_side = BUY if side.upper() == "BUY" else SELL
            
            if price is None:
                if sgn_side == BUY:
                    if not usdc_amount: raise ValueError("Buy Market requires Amount (USDC)")
                    amt = float(usdc_amount)
                else:
                    if not size: raise ValueError("Sell Market requires Size (Shares)")
                    amt = float(size)
                    
                mo = MarketOrderArgs(token_id=token_id, amount=amt, side=sgn_side, order_type=OrderType.FOK)
                signed = client.create_market_order(mo)
                resp = client.post_order(signed, OrderType.FOK)
            else:
                if not size: raise ValueError("Limit Order requires Size")
                order = OrderArgs(price=float(price), size=float(size), side=sgn_side, token_id=token_id)
                signed = client.create_order(order)
                resp = client.post_order(signed, OrderType.GTC)
                
            return resp
        except Exception as e:
            traceback.print_exc()
            raise e
''')

    # 5. copy_trading_service.py
    create_file("copy_trading_service.py", '''import threading
import time
import traceback
import db
import fetcher
from services.trade_service import TradeService
from services.market_service import MarketService
from eth_utils import to_checksum_address
import re

class CopyTradingService:
    def __init__(self):
        self.running = False
        self.thread = None
        
    def start(self):
        if self.running: return
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        print("CopyTradingService started")

    def _loop(self):
        while self.running:
            try:
                # Placeholder for automation logic
                pass
            except Exception:
                traceback.print_exc()
            time.sleep(10)

    def execute_copy_trade(self, trade_data, user_settings):
        # Implementation for automated execution
        pass
''')

    # 6. arbitrage_service.py
    create_file("arbitrage_service.py", '''class ArbitrageService:
    def __init__(self):
        pass
        
    def find_opportunities(self):
        # Placeholder for Strategy 2
        return []
''')

    # 7. __init__.py
    create_file("__init__.py", "")

if __name__ == "__main__":
    main()
