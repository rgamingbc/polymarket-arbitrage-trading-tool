from flask import Flask, render_template, request, redirect, url_for, jsonify, session
import json
import requests
import re
import db
import fetcher
import traceback
import threading
import time
from eth_utils import to_checksum_address
import os
from eth_account import Account

# Import Services
from services.wallet_service import WalletService
from services.market_service import MarketService
from services.trade_service import TradeService
from services.copy_trading_service import CopyTradingService
from services.arbitrage_service import ArbitrageService
from services.utils import rate_limit

# Initialize DB
db.init_db()

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET", "dev-secret")

# Initialize Background Services
copy_service = CopyTradingService()
copy_service.start()

arb_service = ArbitrageService()

# --- Background Data Fetcher (Legacy) ---
def _background_updater():
    while True:
        try:
            traders = db.list_traders()
            for t in traders:
                addr = t.get("address")
                if not addr: continue
                try:
                    activity = fetcher.fetch_activity_for_user(addr)
                    if activity:
                        for item in activity:
                            if item.get("type") == "TRADE":
                                db.add_trade(item)
                                # Notify Copy Service (if we had event bus)
                                # For now, CopyService polls DB or API independently
                except Exception:
                    pass
        except Exception:
            traceback.print_exc()
        time.sleep(20)

try:
    threading.Thread(target=_background_updater, daemon=True).start()
except Exception:
    pass

# --- Routes ---

@app.route("/", methods=["GET"])
def index():
    # This is now the "Copy Trading" strategy page (Strategy 1)
    traders = db.list_traders()
    stats = db.get_trader_stats()
    def norm(u):
        if not u or not isinstance(u, str): return None
        if u.startswith("ipfs://"):
            h = u.replace("ipfs://", "").strip()
            return f"https://cloudflare-ipfs.com/ipfs/{h}"
        return u
    for t in traders:
        t["profile_image"] = norm(t.get("profile_image")) or t.get("profile_image")
    return render_template("index.html", traders=traders, stats=stats, page="copy_trading")

@app.route("/arbitrage", methods=["GET"])
def arbitrage():
    # Strategy 2
    opportunities = arb_service.find_opportunities()
    return render_template("index.html", opportunities=opportunities, page="arbitrage")

@app.route("/monitor", methods=["GET"])
def monitor():
    # Monitor Page (Wallet, Market, Realtime)
    # We can reuse the wallet/settings view here or create a dashboard
    return render_template("index.html", page="monitor")

@app.route("/add-trader", methods=["POST"])
def add_trader():
    address = request.form.get("address", "").strip()
    if address:
        db.add_trader(address)
        # Initial fetch
        try:
            activity = fetcher.fetch_activity_for_user(address)
            if len(activity) > 0:
                fetcher.update_trader_profile(address, activity[0])
                for item in activity:
                    if item.get("type") == "TRADE":
                        db.add_trade(item)
            else:
                trades = fetcher.fetch_trades_for_user(address)
                if len(trades) > 0:
                    fetcher.update_trader_profile(address, trades[0])
                    for trade in trades:
                        db.add_trade(trade)
        except:
            traceback.print_exc()
    return redirect(url_for("index"))

@app.route("/trader/<address>", methods=["GET"])
def trader(address: str):
    traders = [t for t in db.list_traders() if t["address"].lower() == address.lower()]
    trader_info = traders[0] if traders else {"address": address}
    trades = db.get_trades_for_trader(address, limit=200)
    return render_template("trader.html", trader=trader_info, trades=trades)

@app.route("/api/traders", methods=["GET"])
def api_traders():
    return jsonify(db.list_traders())

@app.route("/api/trades", methods=["GET"])
def api_trades():
    address = request.args.get("address", "").strip()
    if not address: return jsonify([])
    return jsonify(db.get_trades_for_trader(address, limit=200))

@app.route("/api/recent-trades", methods=["GET"])
def api_recent_trades():
    return jsonify(db.get_recent_trades(limit=200))

@app.route("/api/settings", methods=["GET"])
def get_user_settings():
    try:
        settings = db.get_settings()
        if not settings:
            return jsonify({"configured": False})
        pk = settings.get("private_key")
        masked_pk = ""
        if pk and len(pk) > 8:
            masked_pk = pk[:4] + "..." + pk[-4:]
        return jsonify({
            "configured": True,
            "funder": settings.get("funder"),
            "signature_type": settings.get("signature_type"),
            "masked_pk": masked_pk
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/set-creds", methods=["POST"])
def set_creds():
    try:
        data = request.get_json(force=True)
        pk = (data.get("private_key") or "").strip()
        if pk.lower().startswith("0x"): pk = pk[2:]
        pk = re.sub(r'[^0-9a-fA-F]', '', pk)
        
        funder = (data.get("funder") or "").strip()
        sig_type = int(data.get("signature_type") or 0)
        
        if not pk:
            return jsonify({"error": "missing credentials"}), 400

        try:
            acct = Account.from_key(pk)
            derived_addr = acct.address
            
            # Logic: If user provided funder, use it. If not, detect.
            if sig_type == 2:
                if not funder:
                    detected = WalletService.detect_proxy(derived_addr)
                    if detected:
                        funder = detected
                    else:
                        return jsonify({"error": "Could not auto-detect Proxy Address. Please enter manually."}), 400
            else:
                if funder and funder.lower() != derived_addr.lower():
                    sig_type = 2
                elif not funder:
                    detected = WalletService.detect_proxy(derived_addr)
                    if detected:
                        funder = detected
                        sig_type = 2
                    else:
                        funder = derived_addr
                        sig_type = 0
                
        except Exception as e:
            return jsonify({"error": f"Invalid Private Key: {str(e)}"}), 400

        session["private_key"] = pk
        session["funder"] = funder
        session["signature_type"] = sig_type
        db.save_settings(pk, funder, sig_type)
        
        return jsonify({
            "ok": True, 
            "funder": funder,
            "signature_type": sig_type,
            "message": "Proxy detected & configured" if sig_type == 2 else "EOA configured"
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/repeat-order", methods=["POST"])
@rate_limit()
def repeat_order():
    # Legacy manual copy endpoint
    # Re-implemented using TradeService logic would be better, but keeping old logic 
    # adapted to use services where possible or just keeping it for stability.
    # Let's adapt it to use TradeService partially.
    try:
        data = request.get_json(force=True)
        slug = (data.get("slug") or "").strip()
        outcome = data.get("outcome")
        side = (data.get("side") or "").strip()
        size = data.get("size")
        usdc_amount = data.get("usdc_size")
        outcome_index = data.get("outcome_index")
        price = data.get("price")
        
        if not slug or side.lower() not in ["buy", "sell"]:
            return jsonify({"success": False, "error": "invalid input"}), 400
            
        s = db.get_settings()
        if not s: return jsonify({"error": "No settings"}), 400
        
        pk = s.get("private_key")
        funder = s.get("funder")
        sig_type = s.get("signature_type")
        
        if not pk: return jsonify({"error": "missing credentials"}), 400
        
        if pk.lower().startswith("0x"): pk = pk[2:]
        pk = re.sub(r'[^0-9a-fA-F]', '', pk)
        
        # Resolve Token
        token_id = MarketService.resolve_token_id(slug, outcome_index, outcome)
        if not token_id:
            return jsonify({"success": False, "error": "token not found"}), 400
            
        # Clean funder
        if funder:
            try: funder = to_checksum_address(funder)
            except: pass
            if funder.lower().startswith("0x9402"): sig_type = 2
            
        # Execute
        client = TradeService.get_client(pk, sig_type, funder)
        resp = TradeService.place_order(client, token_id, side, size=size, price=price, usdc_amount=usdc_amount)
        
        resp = resp if isinstance(resp, dict) else {"orderId": resp}
        resp["success"] = True
        return jsonify(resp)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 400

@app.route("/api/approve", methods=["POST"])
def api_approve():
    # Keep original logic or move to WalletService? 
    # WalletService doesn't have write methods yet. Keeping original for safety.
    # ... (Original implementation omitted for brevity in prompt, but needed in file)
    # Since I'm overwriting the file, I MUST include the logic!
    try:
        pk = session.get("private_key")
        if not pk: return jsonify({"success": False, "error": "missing credentials"}), 400
        if pk.lower().startswith("0x"): pk = pk[2:]
        pk = re.sub(r'[^0-9a-fA-F]', '', pk)
        acct = Account.from_key(pk)
        owner = acct.address
        spender = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
        token = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
        r = requests.post("https://polygon-rpc.com", json={"jsonrpc":"2.0","method":"eth_getTransactionCount","params":[owner,"latest"],"id":1})
        nonce = int(r.json()["result"], 16)
        r = requests.post("https://polygon-rpc.com", json={"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":1})
        gas_price = int(r.json()["result"], 16)
        selector = "0x095ea7b3"
        p_spender = spender.replace("0x", "").rjust(64, "0")
        p_amount = "f" * 64
        data = selector + p_spender + p_amount
        tx = {"to":token,"value":0,"gas":100000,"gasPrice":int(gas_price*1.5),"nonce":nonce,"chainId":137,"data":data}
        signed = acct.sign_transaction(tx)
        r = requests.post("https://polygon-rpc.com", json={"jsonrpc":"2.0","method":"eth_sendRawTransaction","params":[signed.rawTransaction.hex()],"id":1})
        res = r.json()
        if "error" in res: return jsonify({"success": False, "error": res["error"]["message"]})
        return jsonify({"success": True, "txHash": res["result"]})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/cash", methods=["GET"])
@rate_limit()
def api_cash():
    try:
        # Load Creds
        pk = session.get("private_key")
        funder = session.get("funder")
        sig_type = session.get("signature_type")
        
        if not pk or not funder:
            s = db.get_settings()
            if s:
                pk = s.get("private_key")
                funder = s.get("funder")
                sig_type = s.get("signature_type")
                session["private_key"] = pk
                session["funder"] = funder
                session["signature_type"] = sig_type
        
        if not pk: return jsonify({"error": "missing credentials"}), 400
        if pk.lower().startswith("0x"): pk = pk[2:]
        pk = re.sub(r'[^0-9a-fA-F]', '', pk)
        try: sig_type = int(sig_type or 0)
        except: sig_type = 0
        
        if not funder:
            try:
                acct = Account.from_key(pk)
                funder = acct.address
                detected = WalletService.detect_proxy(funder)
                if detected:
                    funder = detected
                    sig_type = 2
            except: pass
            
        if funder and funder.lower().startswith("0x9402"): sig_type = 2
        
        # Use WalletService
        balances = WalletService.get_balances(pk, funder, sig_type, TradeService.get_client)
        return jsonify(balances)
        
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/place-order", methods=["POST"])
@rate_limit()
def place_order():
    try:
        data = request.get_json(force=True)
        print(f"DEBUG: place_order data: {data}")
        
        slug = (data.get("slug") or "").strip()
        outcome = data.get("outcome")
        side = (data.get("side") or "").strip().upper()
        order_type = (data.get("order_type") or "MARKET").strip().upper()
        price = data.get("price")
        size = data.get("size")
        usdc_amount = data.get("usdc_amount")
        
        if side not in ["BUY", "SELL"]:
            return jsonify({"success": False, "error": "Invalid side"}), 400
            
        s = db.get_settings()
        if not s: return jsonify({"error": "No settings"}), 400
        pk = s.get("private_key")
        funder = s.get("funder")
        sig_type = s.get("signature_type")
        
        if not pk: return jsonify({"error": "Missing Private Key"}), 400
        if pk.lower().startswith("0x"): pk = pk[2:]
        pk = re.sub(r'[^0-9a-fA-F]', '', pk)
        
        if funder:
            try: funder = to_checksum_address(funder)
            except: pass
            if funder.lower().startswith("0x9402"): sig_type = 2
        else:
            funder = None
            
        try: sig_type = int(sig_type or 0)
        except: sig_type = 0
        
        # Resolve Token ID
        token_id = None
        if slug.isdigit() and len(slug) > 10:
             token_id = slug
        else:
             token_id = MarketService.resolve_token_id(slug, outcome=outcome)
             # Note: resolve_token_id in MarketService might behave slightly differently than local logic, check params.
             # MarketService.resolve_token_id takes (slug, outcome_index, outcome)
             # Here we pass outcome name.
        
        if not token_id:
             return jsonify({"success": False, "error": "Could not resolve Token ID"}), 400

        # Execute
        client = TradeService.get_client(pk, sig_type, funder)
        resp = TradeService.place_order(client, token_id, side, size=size, price=price, usdc_amount=usdc_amount)
        
        resp = resp if isinstance(resp, dict) else {"orderId": resp}
        resp["success"] = True
        return jsonify(resp)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 400

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=True)
