import os

APP_JS_PATH = "app.js"

def patch_app_js():
    if not os.path.exists(APP_JS_PATH):
        print(f"Error: {APP_JS_PATH} not found")
        return

    with open(APP_JS_PATH, "r") as f:
        content = f.read()

    # Add Modal Functions if not present
    if "function openManualTradeModal" not in content:
        js_code = '''
function openManualTradeModal() {
  document.getElementById("manual-trade-modal").style.display = "block";
}

function closeManualTradeModal() {
  document.getElementById("manual-trade-modal").style.display = "none";
}

async function submitManualTrade() {
  const slug = document.getElementById("mt-slug").value;
  const outcome = document.getElementById("mt-outcome").value;
  const side = document.getElementById("mt-side").value;
  const type = document.getElementById("mt-type").value;
  const price = document.getElementById("mt-price").value;
  const size = document.getElementById("mt-size").value;
  const amount = document.getElementById("mt-amount").value;

  if (!slug) {
    alert("Please enter a Slug or Token ID");
    return;
  }

  const payload = {
    slug: slug,
    outcome: outcome,
    side: side,
    order_type: type,
    price: price,
    size: size,
    usdc_amount: amount
  };

  try {
    const res = await fetch("/api/place-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    
    const data = await res.json();
    if (data.success) {
      alert("Order Placed Successfully! ID: " + (data.orderId || "OK"));
      closeManualTradeModal();
      fetchRecentTrades().then(renderRecentTrades); // Refresh trades if function exists
    } else {
      alert("Error: " + (data.error || "Unknown error"));
    }
  } catch (e) {
    alert("Network Error: " + e.message);
  }
}
'''
        content += "\n" + js_code
        print("Added Manual Trade JS functions")

    with open(APP_JS_PATH, "w") as f:
        f.write(content)
    print("Successfully patched app.js")

if __name__ == "__main__":
    patch_app_js()
