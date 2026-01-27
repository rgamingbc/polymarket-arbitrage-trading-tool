
import os

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

# Patch app.py set_creds logic
old_logic = """            # Logic: If user provided funder, use it. If not, detect.
            if funder and funder.lower() != derived_addr.lower():
                if sig_type == 0: sig_type = 2
            elif not funder:
                detected = _detect_proxy(derived_addr)
                if detected:
                    funder = detected
                    sig_type = 2
                else:
                    funder = derived_addr
            
            if funder.lower() == derived_addr.lower():
                sig_type = 0"""

new_logic = """            # Logic: If user provided funder, use it. If not, detect.
            if sig_type == 2:
                # User explicitly selected Proxy/Magic
                if not funder:
                    detected = _detect_proxy(derived_addr)
                    if detected:
                        funder = detected
                    else:
                        return jsonify({"error": "Could not auto-detect Proxy Address. Please enter your Polymarket Address manually (starts with 0x...)."}), 400
            else:
                # EOA or Legacy
                if funder and funder.lower() != derived_addr.lower():
                    # If they provided a different address, assume Proxy
                    sig_type = 2
                elif not funder:
                    detected = _detect_proxy(derived_addr)
                    if detected:
                        funder = detected
                        sig_type = 2
                    else:
                        funder = derived_addr
                        sig_type = 0"""

patch_file('../app.py', old_logic, new_logic)
