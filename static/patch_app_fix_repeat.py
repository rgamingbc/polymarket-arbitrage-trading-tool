
from eth_utils import to_checksum_address

def patch_file(file_path, old_str, new_str):
    with open(file_path, 'r') as f:
        content = f.read()
    
    if old_str not in content:
        print(f"Error: Could not find old_str in {file_path}")
        return False
        
    new_content = content.replace(old_str, new_str)
    
    with open(file_path, 'w') as f:
        f.write(new_content)
    
    print(f"Successfully patched {file_path}")
    return True

# 1. Add import
patch_file('../app.py', 'from web3 import Web3', 'from web3 import Web3\nfrom eth_utils import to_checksum_address')

# 2. Fix repeat_order reloading and checksumming
old_logic = """        pk = session.get("private_key")
        # Reload if missing
        if not pk:
            s = db.get_settings()
            if s:
                pk = s.get("private_key")
                session["private_key"] = pk
                session["funder"] = s.get("funder")
                session["signature_type"] = s.get("signature_type")
        
        if not pk:
            return jsonify({"error": "missing credentials"}), 400
            
        if pk.lower().startswith("0x"): pk = pk[2:]
        pk = re.sub(r'[^0-9a-fA-F]', '', pk)
        
        token_id = _resolve_token_id(slug, outcome_index, outcome)
        if not token_id:
            return jsonify({"success": False, "error": "token not found"}), 400
            
        sig_type = int(session.get("signature_type", 0))
        funder = session.get("funder") or None"""

new_logic = """        pk = session.get("private_key")
        funder = session.get("funder")
        sig_type = session.get("signature_type")

        # Reload if credentials missing
        if not pk or (sig_type == 2 and not funder):
            s = db.get_settings()
            if s:
                pk = s.get("private_key")
                funder = s.get("funder")
                sig_type = s.get("signature_type")
                session["private_key"] = pk
                session["funder"] = funder
                session["signature_type"] = sig_type
        
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
            
        print(f"DEBUG: repeat_order using Funder={funder}, SigType={sig_type}")"""

patch_file('../app.py', old_logic, new_logic)
