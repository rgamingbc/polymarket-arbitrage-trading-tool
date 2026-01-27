import requests
from eth_utils import to_checksum_address

addr = "0x9402884ec6e9c1d26b4cd1769237161424" # Lowercase manually
try:
    csum = to_checksum_address(addr)
    print(f"Checksummed: {csum}")
    
    url = f"https://safe-transaction-polygon.safe.global/api/v1/owners/{csum}/safes/"
    print(f"Querying: {url}")
    
    r = requests.get(url)
    print(f"Status: {r.status_code}")
    print(f"Body: {r.text}")
    
    if r.status_code == 200:
        data = r.json()
        safes = data.get("safes", [])
        if safes:
            print(f"FOUND PROXY: {safes[0]}")
            # Check balance
            proxy = safes[0]
            usdc_e = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
             # Check RPC
            selector = "0x70a08231"
            padded = proxy.replace("0x", "").rjust(64, "0")
            data_rpc = selector + padded
            
            r2 = requests.post("https://polygon-rpc.com", json={
                "jsonrpc": "2.0", "method": "eth_call",
                "params": [{"to": usdc_e, "data": data_rpc}, "latest"], "id": 1
            })
            if r2.status_code == 200:
                res = r2.json().get("result")
                val = int(res, 16) / 1e6
                print(f"PROXY BALANCE: {val} USDC.e")
        else:
            print("NO SAFES FOUND")

except Exception as e:
    print(f"Error: {e}")
