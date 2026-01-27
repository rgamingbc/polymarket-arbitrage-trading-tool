import os

APP_PATH = "../app.py"

def patch_app_manual():
    if not os.path.exists(APP_PATH):
        print(f"Error: {APP_PATH} not found")
        return

    with open(APP_PATH, "r") as f:
        content = f.read()

    # Ensure eth_utils import
    if "from eth_utils import to_checksum_address" not in content:
        content = content.replace("import time", "import time\nfrom eth_utils import to_checksum_address")
        print("Added eth_utils import")

    # Add /api/place-order endpoint
    if "/api/place-order" not in content:
        new_endpoint = '''
@app.route("/api/place-order", methods=["POST"])
def place_order():
    try:
        data = request.get_json(force=True)
        print(f"DEBUG: place_order data: {data}")
        
        slug = (data.get("slug") or "").strip()
        # If slug looks like a token ID (large integer string), use it directly? 
        # But usually token IDs are handled by resolving slug + outcome.
        # Let's assume input is SLUG first.
        
        outcome = data.get("outcome") # Yes/No
        side = (data.get("side") or "").strip().upper()
        order_type = (data.get("order_type") or "MARKET").strip().upper()
        price = data.get("price")
        size = data.get("size")
        usdc_amount = data.get("usdc_amount")
        
        # Validation
        if side not in ["BUY", "SELL"]:
            return jsonify({"success": False, "error": "Invalid side"}), 400
            
        # FORCE RELOAD FROM DB
        s = db.get_settings()
        if not s:
            return jsonify({"error": "No settings found. Please configure wallet first."}), 400
            
        pk = s.get("private_key")
        funder = s.get("funder")
        sig_type = s.get("signature_type")
        
        if not pk:
            return jsonify({"error": "Missing Private Key"}), 400
            
        # Clean PK
        if pk.lower().startswith("0x"): pk = pk[2:]
        pk = re.sub(r'[^0-9a-fA-F]', '', pk)
        
        # Clean Funder & Detect Magic
        if funder:
            try: funder = to_checksum_address(funder)
            except: pass
            if funder.lower().startswith("0x9402"):
                sig_type = 2
                print(f"DEBUG: Detected Magic Wallet {funder}, forcing sig_type=2")
        else:
            funder = None
            
        try: sig_type = int(sig_type or 0)
        except: sig_type = 0
        
        print(f"DEBUG: place_order using Funder={funder}, SigType={sig_type}")

        # Resolve Token ID
        # If input slug is actually a token ID (digits), use it.
        token_id = None
        if slug.isdigit() and len(slug) > 10:
             token_id = slug
        else:
             # Resolve via gamma
             # If outcome is provided, use it. If not, default?
             # For Manual Trade, user selects Outcome.
             outcome_index = 0 if outcome == "Yes" else 1 # Simple binary assumption
             # Wait, _resolve_token_id uses outcome string "Yes"/"No" usually?
             # Let's check _resolve_token_id logic in app.py
             # It calls _get_market_by_slug -> clobTokenIds
             # clobTokenIds is usually [token_yes, token_no]
             
             m = _get_market_by_slug(slug)
             if not m:
                 return jsonify({"success": False, "error": "Market not found"}), 400
             tokens = m.get("clobTokenIds")
             if not tokens or len(tokens) < 2:
                 return jsonify({"success": False, "error": "Tokens not found in market"}), 400
             
             # If outcome is specified, pick correct token
             if outcome == "No":
                 token_id = tokens[1]
             else:
                 token_id = tokens[0] # Default to Yes
        
        if not token_id:
             return jsonify({"success": False, "error": "Could not resolve Token ID"}), 400

        # Init Client
        from py_clob_client.clob_types import OrderArgs, OrderType, MarketOrderArgs
        from py_clob_client.order_builder.constants import BUY, SELL
        
        client = get_clob_client(pk, sig_type, funder)
        
        sgn_side = BUY if side == "BUY" else SELL
        
        resp = None
        
        if order_type == "MARKET":
            # Market Order
            # BUY: needs Amount (USDC)
            # SELL: needs Size (Shares)
            
            amt = 0.0
            if sgn_side == BUY:
                 if not usdc_amount:
                      return jsonify({"success": False, "error": "Buy Market requires Amount (USDC)"}), 400
                 amt = float(usdc_amount)
            else:
                 if not size:
                      return jsonify({"success": False, "error": "Sell Market requires Size (Shares)"}), 400
                 amt = float(size)
                 
            print(f"DEBUG: Placing Market Order. Side={side}, Amount={amt}")
            mo = MarketOrderArgs(token_id=token_id, amount=amt, side=sgn_side, order_type=OrderType.FOK)
            signed = client.create_market_order(mo)
            resp = client.post_order(signed, OrderType.FOK)
            
        else:
            # Limit Order
            if not price or not size:
                 return jsonify({"success": False, "error": "Limit Order requires Price and Size"}), 400
                 
            print(f"DEBUG: Placing Limit Order. Side={side}, Size={size}, Price={price}")
            order = OrderArgs(price=float(price), size=float(size), side=sgn_side, token_id=token_id)
            signed = client.create_order(order)
            resp = client.post_order(signed, OrderType.GTC) # GTC for limit
            
        resp = resp if isinstance(resp, dict) else {"orderId": resp}
        resp["success"] = True
        return jsonify(resp)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 400
'''
        content += "\n" + new_endpoint
        print("Added /api/place-order endpoint")

    with open(APP_PATH, "w") as f:
        f.write(content)
    print("Successfully patched app.py with manual order endpoint")

if __name__ == "__main__":
    patch_app_manual()
