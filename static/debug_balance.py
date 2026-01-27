import os
import sys
import traceback
import requests
from eth_account import Account

# 1. Check if py_clob_client is importable
print("--- Checking py_clob_client ---")
try:
    from py_clob_client.client import ClobClient
    from py_clob_client.constants import POLYGON
    print("py_clob_client imported successfully")
except ImportError:
    print("py_clob_client NOT found")
except Exception as e:
    print(f"py_clob_client import error: {e}")

# 2. Check the specific address
# We don't have the user's PK here (it's in session), but we can check the public address 
# seen in the screenshot: 0x9402884EC6e9C1D26b4CD1769237161424
ADDR = "0x9402884EC6e9C1D26b4CD1769237161424"
USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"

def get_balance(addr, token):
    try:
        selector = "0x70a08231"
        padded = addr.replace("0x", "").rjust(64, "0")
        data = selector + padded
        r = requests.post("https://polygon-rpc.com", json={
            "jsonrpc": "2.0", "method": "eth_call",
            "params": [{"to": token, "data": data}, "latest"], "id": 1
        }, timeout=10)
        if r.status_code == 200:
            res = r.json().get("result")
            if res:
                return int(res, 16) / 1e6
    except Exception as e:
        print(f"RPC Error: {e}")
    return -1

print(f"--- Checking RPC Balance for {ADDR} ---")
b = get_balance(ADDR, USDC_E)
print(f"USDC.e Balance: {b}")

# 3. Check for Proxy (Gnosis Safe) via Polymarket API
# Usually GET https://data-api.polymarket.com/users?address=... or similar
print("--- Checking Polymarket Proxy ---")
try:
    r = requests.get(f"https://profile-api.polymarket.com/profile?address={ADDR}") # Guessing endpoint
    print(f"Profile API (Profile): {r.status_code} {r.text[:200]}")
    
    # Try another known endpoint for user info
    r = requests.get(f"https://data-api.polymarket.com/user/{ADDR}")
    print(f"Data API (User): {r.status_code} {r.text[:200]}")
    
except Exception as e:
    print(f"API Check Error: {e}")

