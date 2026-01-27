import os
import re

APP_PATH = "../app.py"

def patch_app():
    if not os.path.exists(APP_PATH):
        print(f"Error: {APP_PATH} not found")
        return

    with open(APP_PATH, "r") as f:
        content = f.read()

    # 1. Add eth_utils import if missing
    if "from eth_utils import to_checksum_address" not in content:
        content = content.replace("import time", "import time\nfrom eth_utils import to_checksum_address")
        print("Added eth_utils import")

    # 2. Replace the entire repeat_order function
    # We'll use a regex to find the function body to ensure we get it all, or just replace the known structure if regex is too risky.
    # Given the complexity, let's look for the start and end of the function.
    
    start_marker = '@app.route("/api/repeat-order", methods=["POST"])\ndef repeat_order():'
    
    # We will construct the NEW function body.
    new_function = '''@app.route("/api/repeat-order", methods=["POST"])
def repeat_order():
    try:
        data = request.get_json(force=True)
        print(f"DEBUG: repeat_order data: {data}")
        slug = (data.get("slug") or "").strip()
        outcome_index = data.get("outcome_index")
        outcome = data.get("outcome")
        side = (data.get("side") or "").strip()
        size = data.get("size")
        price = data.get("price")
        usdc_amount = data.get("usdc_size")
        
        if not slug or side.lower() not in ["buy", "sell"]:
            return jsonify({"success": False, "error": "invalid input"}), 400
            
        # FORCE RELOAD FROM DB to ensure latest settings
        pk = None
        funder = None
        sig_type = 0
        
        s = db.get_settings()
        if s:
            pk = s.get("private_key")
            funder = s.get("funder")
            sig_type = s.get("signature_type")
            print(f"DEBUG: Loaded settings from DB: Funder={funder}, SigType={sig_type}")
            # Update session
            session["private_key"] = pk
            session["funder"] = funder
            session["signature_type"] = sig_type
        else:
            pk = session.get("private_key")
            funder = session.get("funder")
            sig_type = session.get("signature_type")
            print(f"DEBUG: Loaded settings from Session: Funder={funder}, SigType={sig_type}")
        
        if not pk:
            return jsonify({"error": "missing credentials"}), 400
            
        if pk.lower().startswith("0x"): pk = pk[2:]
        pk = re.sub(r'[^0-9a-fA-F]', '', pk)
        
        token_id = _resolve_token_id(slug, outcome_index, outcome)
        if not token_id:
            return jsonify({"success": False, "error": "token not found"}), 400
            
        try: sig_type = int(sig_type or 0)
        except: sig_type = 0
        
        if funder:
            try: funder = to_checksum_address(funder)
            except: pass
        else:
            funder = None

        # Force Safe Proxy for known Magic wallets (same as api_cash)
        if funder and funder.lower().startswith("0x9402"):
            sig_type = 2
            print(f"DEBUG: Detected Magic Wallet {funder}, forcing sig_type=2")
            
        print(f"DEBUG: repeat_order using Funder={funder}, SigType={sig_type}")
        
        if sig_type == 2 and not funder:
             return jsonify({"success": False, "error": "Proxy Address required for Signature Type 2"}), 400

        try:
            from py_clob_client.clob_types import OrderArgs, OrderType, MarketOrderArgs
            from py_clob_client.order_builder.constants import BUY, SELL
            
            # Initialize client
            client = get_clob_client(pk, sig_type, funder)
            
            sgn_side = BUY if side.lower() == "buy" else SELL
            
            if usdc_amount is not None:
                # BUY with USDC amount
                try: amt = float(usdc_amount)
                except: amt = None
                if amt is None or amt <= 0:
                    return jsonify({"success": False, "error": "invalid usdc amount"}), 400
                
                print(f"DEBUG: Placing Market Order (USDC). Side={side}, Amount={amt}")
                mo = MarketOrderArgs(token_id=token_id, amount=amt, side=sgn_side, order_type=OrderType.FOK)
                signed = client.create_market_order(mo)
                resp = client.post_order(signed, OrderType.FOK)
                
            elif price is not None and size is not None:
                # LIMIT ORDER
                print(f"DEBUG: Placing Limit Order. Side={side}, Size={size}, Price={price}")
                order = OrderArgs(price=float(price), size=float(size), side=sgn_side, token_id=token_id)
                signed = client.create_order(order)
                resp = client.post_order(signed, OrderType.GTC)
                
            else:
                # MARKET ORDER using Size (Shares)
                mid = client.get_midpoint(token_id)
                try: sz = float(size or 0)
                except: sz = 0.0
                
                # For BUY: amount is USDC (cost)
                # For SELL: amount is SHARES (size)
                if sgn_side == SELL:
                    amt = sz
                else:
                    amt = float(mid) * sz

                if amt <= 0:
                    return jsonify({"success": False, "error": "missing size/price/usdc amount"}), 400
                
                print(f"DEBUG: Placing Market Order (Size). Side={side}, Size={sz}, Price={mid}, Amount={amt}")
                mo = MarketOrderArgs(token_id=token_id, amount=amt, side=sgn_side, order_type=OrderType.FOK)
                signed = client.create_market_order(mo)
                resp = client.post_order(signed, OrderType.FOK)
                
            resp = resp if isinstance(resp, dict) else {"orderId": resp}
            resp["success"] = True
            return jsonify(resp)
            
        except Exception as e:
            traceback.print_exc()
            return jsonify({"success": False, "error": str(e)}), 400
            
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 400'''

    # We need to find the old function block to replace it.
    # The old function starts with the decorator and ends before the next route or end of file.
    # A simple way is to read the file, identify the block, and replace.
    # However, since the file content might vary slightly, let's use the start marker and assume indentation.
    
    if start_marker in content:
        # Find where the next function starts (e.g., @app.route)
        start_idx = content.find(start_marker)
        
        # Find the next @app.route after this one
        next_route_idx = content.find('@app.route', start_idx + len(start_marker))
        
        if next_route_idx != -1:
            # Replace everything between start_idx and next_route_idx
            old_block = content[start_idx:next_route_idx]
            # Be careful not to eat the next route's decorator
            # We need to ensure we are replacing just the function.
            # Let's assume there's some blank lines between functions.
            
            # Safer approach: Regular expression to match the function body based on indentation
            pass
        else:
            # It's the last function
            pass

    # Since regex for python blocks is tricky, let's do a hard replace of the specific flawed logic if possible, 
    # OR just rewrite the file if we can match the block.
    # Given the previous context, we know the file content structure from previous reads.
    # Let's try to locate the specific flawed lines and patch them, or the whole function if possible.
    
    # Strategy: Replace the whole file content for that function using a robust regex.
    # Pattern: @app\.route\("/api/repeat-order".*?def repeat_order\(\):.*?return jsonify\({"success": False, "error": str\(e\)}\), 400
    
    pattern = re.compile(r'@app\.route\("/api/repeat-order", methods=\["POST"\]\)\s+def repeat_order\(\):(.*?)return jsonify\({"success": False, "error": str\(e\)}\), 400', re.DOTALL)
    
    match = pattern.search(content)
    if match:
        print("Found repeat_order function block.")
        # We replace the whole match with our new function
        # Note: The regex above matches up to the LAST return 400 in the function. 
        # But wait, python indentation...
        # A safer way: Read the file, find lines, replace range.
        
        lines = content.splitlines()
        start_line = -1
        end_line = -1
        
        for i, line in enumerate(lines):
            if '@app.route("/api/repeat-order", methods=["POST"])' in line:
                start_line = i
            if start_line != -1 and i > start_line and line.startswith('@app.route'):
                end_line = i
                break
        
        if end_line == -1:
            end_line = len(lines)
            
        if start_line != -1:
            print(f"Replacing lines {start_line} to {end_line}")
            new_lines = new_function.splitlines()
            final_lines = lines[:start_line] + new_lines + lines[end_line:]
            new_content = "\n".join(final_lines)
            
            with open(APP_PATH, "w") as f:
                f.write(new_content)
            print("Successfully patched repeat_order in app.py")
        else:
            print("Could not find repeat_order function start")
    else:
        print("Regex match failed, trying simple search")
        # Fallback to the line-by-line method which I included in the regex block logic above anyway
        lines = content.splitlines()
        start_line = -1
        end_line = -1
        
        for i, line in enumerate(lines):
            if '@app.route("/api/repeat-order", methods=["POST"])' in line:
                start_line = i
            if start_line != -1 and i > start_line and line.strip().startswith('@app.route'):
                end_line = i
                break
        
        if end_line == -1:
            end_line = len(lines)
            
        if start_line != -1:
            print(f"Replacing lines {start_line} to {end_line}")
            new_lines = new_function.splitlines()
            final_lines = lines[:start_line] + new_lines + lines[end_line:]
            new_content = "\n".join(final_lines)
            
            with open(APP_PATH, "w") as f:
                f.write(new_content)
            print("Successfully patched repeat_order in app.py")

if __name__ == "__main__":
    patch_app()
