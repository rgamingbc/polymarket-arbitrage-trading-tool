
import os
import sqlite3
import json
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds

def get_db_connection():
    conn = sqlite3.connect('polymarket.db')
    conn.row_factory = sqlite3.Row
    return conn

def check_proxy():
    conn = get_db_connection()
    row = conn.execute('SELECT * FROM settings LIMIT 1').fetchone()
    conn.close()

    if not row:
        print("No settings found in DB")
        return

    pk = row['private_key']
    print(f"Using PK: {pk[:6]}...{pk[-4:]}")

    # 1. L1 Client
    try:
        client = ClobClient(host="https://clob.polymarket.com", key=pk, chain_id=137)
        print("L1 Client initialized.")
        
        # 2. Derive Creds
        creds = client.create_or_derive_api_creds()
        print(f"Creds derived: {creds}")

        # 3. L2 Client (EOA mode first)
        client_l2 = ClobClient(host="https://clob.polymarket.com", key=pk, chain_id=137, creds=creds)
        
        # 4. Try to get API Keys (L2)
        try:
            keys = client_l2.get_api_keys()
            print(f"API Keys: {keys}")
        except Exception as e:
            print(f"get_api_keys failed: {e}")

        # 5. Try to check balance with SigType=2 and Funder=Derived Address (EOA)
        # This is expected to fail or return 0, but maybe it gives a hint?
        try:
            client_proxy = ClobClient(
                host="https://clob.polymarket.com", 
                key=pk, 
                chain_id=137, 
                creds=creds, 
                signature_type=2, 
                funder=client.get_address()
            )
            # Try a request
            print("Checking balance with SigType=2, Funder=EOA...")
            bal = client_proxy.get_balance()
            print(f"Balance (SigType=2, Funder=EOA): {bal}")
        except Exception as e:
            print(f"SigType=2 check failed: {e}")

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_proxy()
