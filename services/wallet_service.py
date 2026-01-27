import requests
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
