import os

TEMPLATE_PATH = "../templates/index.html"

def patch_templates():
    if not os.path.exists(TEMPLATE_PATH):
        print(f"Error: {TEMPLATE_PATH} not found")
        return

    with open(TEMPLATE_PATH, "r") as f:
        content = f.read()

    # 1. Add Manual Trade Button in Header
    if "Manual Trade" not in content:
        # Find where to insert. Maybe after the "Polymarket Monitor" title or in a new action bar?
        # The user has "My Account" "My Order Record" "Settings" in the screenshot.
        # Those are likely injected by app.js or in a separate part of the DOM not in the static HTML?
        # Let's check app.js again later. But for now, let's put it in the header div or just before the container ends.
        # Actually, let's put it right after the <h1> or header div.
        
        # In the provided index.html read:
        # <div class="header">
        #   <div class="title">Polymarket Monitor</div>
        #   <div class="subtitle">Track traders and watch their trades in real time</div>
        # </div>
        
        # We can add a button container here.
        btn_html = '''
    <div class="actions" style="margin-bottom: 20px;">
        <button onclick="openManualTradeModal()" style="padding: 10px 20px; font-size: 16px; cursor: pointer;">Manual Trade</button>
    </div>
'''
        content = content.replace('</div>\n    <form', '</div>' + btn_html + '\n    <form')
        print("Added Manual Trade button")

    # 2. Add Modal HTML
    if "manual-trade-modal" not in content:
        modal_html = '''
  <div id="manual-trade-modal" class="modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:1000;">
    <div class="modal-content" style="background:#1a1a1a; margin: 10% auto; padding: 20px; width: 80%; max-width: 500px; border-radius: 8px; color: white;">
      <h3>Manual Trade</h3>
      
      <div style="margin-bottom: 10px;">
        <label style="display:block;">Market Slug (e.g. "will-btc-hit-100k") OR Token ID</label>
        <input type="text" id="mt-slug" placeholder="Slug or Token ID" style="width:100%; padding: 8px; margin-top: 5px;">
      </div>
      
      <div style="margin-bottom: 10px;">
        <label style="display:block;">Outcome (if using Slug)</label>
        <select id="mt-outcome" style="width:100%; padding: 8px; margin-top: 5px;">
            <option value="">Select Outcome</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
        </select>
      </div>

      <div style="margin-bottom: 10px;">
        <label style="display:block;">Side</label>
        <select id="mt-side" style="width:100%; padding: 8px; margin-top: 5px;">
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
        </select>
      </div>
      
      <div style="margin-bottom: 10px;">
        <label style="display:block;">Order Type</label>
        <select id="mt-type" style="width:100%; padding: 8px; margin-top: 5px;">
            <option value="MARKET">MARKET</option>
            <option value="LIMIT">LIMIT</option>
        </select>
      </div>
      
      <div style="margin-bottom: 10px;">
        <label style="display:block;">Price (Limit only)</label>
        <input type="number" id="mt-price" step="0.01" placeholder="Price" style="width:100%; padding: 8px; margin-top: 5px;">
      </div>
      
      <div style="margin-bottom: 10px;">
        <label style="display:block;">Size (Shares)</label>
        <input type="number" id="mt-size" step="0.1" placeholder="Shares" style="width:100%; padding: 8px; margin-top: 5px;">
      </div>
      
      <div style="margin-bottom: 10px;">
        <label style="display:block;">Amount (USDC - for Buy Market)</label>
        <input type="number" id="mt-amount" step="0.1" placeholder="USDC Amount" style="width:100%; padding: 8px; margin-top: 5px;">
      </div>
      
      <div class="modal-actions" style="margin-top: 20px; text-align: right;">
        <button onclick="closeManualTradeModal()" style="padding: 8px 16px; margin-right: 10px; background: #555; border: none; color: white; cursor: pointer;">Cancel</button>
        <button onclick="submitManualTrade()" style="padding: 8px 16px; background: #007bff; border: none; color: white; cursor: pointer;">Place Order</button>
      </div>
    </div>
  </div>
'''
        content = content.replace('</body>', modal_html + '\n</body>')
        print("Added Manual Trade modal")

    with open(TEMPLATE_PATH, "w") as f:
        f.write(content)
    print("Successfully patched index.html")

if __name__ == "__main__":
    patch_templates()
