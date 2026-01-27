async function fetchTrades(address) {
  const res = await fetch(`/api/trades?address=${encodeURIComponent(address)}`);
  if (!res.ok) return [];
  return await res.json();
}

async function fetchRecentTrades() {
  const res = await fetch(`/api/recent-trades`);
  if (!res.ok) return [];
  return await res.json();
}

async function fetchTraders() {
  const res = await fetch(`/api/traders`);
  if (!res.ok) return [];
  return await res.json();
}

function fmtTs(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

function fmtAgo(ts) {
  if (!ts) return "";
  const now = Date.now();
  const diff = Math.max(0, now - ts * 1000);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function normImg(u, seed) {
  if (!u || typeof u !== "string") {
    const s = seed || "trader";
    return `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(s)}`;
  }
  if (u.startsWith("ipfs://")) {
    const h = u.replace("ipfs://", "");
    return `https://cloudflare-ipfs.com/ipfs/${h}`;
  }
  return u;
}

function getApiKey() {
  try {
    return localStorage.getItem("poly_api_key") || "";
  } catch {
    return "";
  }
}

function setApiKey(k) {
  try {
    localStorage.setItem("poly_api_key", k || "");
  } catch {}
}

function getMyAddress() {
  try {
    return localStorage.getItem("my_address") || "";
  } catch {
    return "";
  }
}

function setMyAddress(addr) {
  try {
    localStorage.setItem("my_address", addr || "");
  } catch {}
}

async function fetchJSON(url, params, apiKey) {
  const u = new URL(url);
  if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) u.searchParams.set(k, v);
    }
  }
  const headers = {};
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetch(u.toString(), { headers });
  if (!res.ok) return null;
  return await res.json().catch(() => null);
}

async function fetchAccountSummary(addr, apiKey) {
  const safeAddr = (addr || "").trim();
  if (!safeAddr) return null;
  const [positions, valueResp, activity] = await Promise.all([
    fetchJSON("https://data-api.polymarket.com/positions", { user: safeAddr }, apiKey),
    fetchJSON("https://data-api.polymarket.com/value", { user: safeAddr }, apiKey),
    fetchJSON("https://data-api.polymarket.com/activity", { user: safeAddr }, apiKey),
  ]);
  let pnlCash = 0;
  if (Array.isArray(positions)) {
    for (const p of positions) {
      const x = Number(p.cashPnl || 0);
      if (!Number.isNaN(x)) pnlCash += x;
    }
  }
  let portfolioValue = 0;
  if (Array.isArray(valueResp) && valueResp.length > 0) {
    const v = valueResp[0];
    portfolioValue = Number((v && (v.value || v.total || v.amount)) || 0) || 0;
  } else if (valueResp && typeof valueResp === "object") {
    portfolioValue = Number(valueResp.value || 0) || 0;
  }
  let displayName = safeAddr;
  let avatar = `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(safeAddr)}`;
  if (Array.isArray(activity) && activity.length > 0) {
    const s = activity[0];
    displayName = s.name || s.pseudonym || safeAddr;
    avatar = normImg(s.profileImageOptimized || s.profileImage, safeAddr);
  }
  return { address: safeAddr, name: displayName, avatar, pnlCash, portfolioValue };
}

function renderAccountBox(summary) {
  let box = document.getElementById("account-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "account-box";
    document.body.appendChild(box);
  }
  if (!summary) {
    box.innerHTML = `
      <div class="account-card">
        <div class="account-row">
          <div class="account-title">My Account</div>
          <button class="btn small" id="open-settings">Settings</button>
        </div>
        <div class="muted">Set your address to view account</div>
      </div>
    `;
    const btn = box.querySelector("#open-settings");
    if (btn) btn.addEventListener("click", openSettingsModal);
    return;
  }
  const traderLink = `/trader/${encodeURIComponent(summary.address)}`;
  const shortAddr = (a) => a ? `${a.slice(0,6)}...${a.slice(-4)}` : "";
  const displayAddr = shortAddr(summary.address);
  box.innerHTML = `
    <div class="account-card">
      <div class="account-row">
        <img src="${summary.avatar}" class="avatar sm" alt="" onerror="this.src='/static/default-avatar.svg';this.onerror=null;">
        <div>
          <div class="name">${summary.name}</div>
          <div class="address">${displayAddr}</div>
        </div>
      </div>
      <div class="account-metrics">
        <div><div class="muted">P/L</div><div>$${Number(summary.pnlCash || 0).toFixed(2)}</div></div>
        <div><div class="muted">Portfolio</div><div>$${Number(summary.portfolioValue || 0).toFixed(2)}</div></div>
        <div><div class="muted">Cash (USDC.e)</div><div id="cash-val">Loading...</div></div>
      </div>
      <div id="wallet-alerts" style="margin-top:8px;font-size:0.85em"></div>
      <div class="account-links">
        <a href="#" id="open-account">My Account</a>
        <a href="${traderLink}">My Order Record</a>
        <button class="btn small" id="open-settings">Settings</button>
      </div>
    </div>
  `;
  const btnA = box.querySelector("#open-account");
  if (btnA) btnA.addEventListener("click", openAccountOverlay);
  const btnS = box.querySelector("#open-settings");
  if (btnS) btnS.addEventListener("click", openSettingsModal);
  
  (async () => {
    try {
      const r = await fetch("/api/cash");
      if (r.status === 400 || r.status === 401) {
          const el = document.getElementById("cash-val");
          if (el) el.innerHTML = "<span style='color:red;font-size:0.8em'>Login Req</span>";
          return;
      }
      const j = await r.json().catch(() => null);
      if (!j) return;
      
      const cash = Number(j.cash || 0);
      const usdcNative = Number(j.usdc_native || 0);
      const matic = Number(j.matic || 0);
      const allowance = Number(j.allowance || 0);
      
      const el = document.getElementById("cash-val");
      if (el) el.textContent = `$${cash.toFixed(2)}`;
      
      const alerts = document.getElementById("wallet-alerts");

      if (cash === 0 && (!j.funder || matic === 0)) {
        const sigType = document.querySelector('select[name="signature_type"]');
        if (sigType && sigType.value === "0" && !window.hasShownProxyHelp) {
          alert("Action Required: We detected $0 Balance.\n\nIf you use Email/Google/Magic login on Polymarket, you are a 'Proxy User'.\n\n1. Copy your Address from the Polymarket Dashboard (top left, e.g. 0x...)\n2. Open Settings (top right)\n3. Paste it into the 'Proxy Address' field\n4. Select 'Polymarket Wallet' (Type 2)\n5. Click Save.");
          window.hasShownProxyHelp = true;
          openSettingsModal();
        }
      }
      
      // Alert 1: Native USDC but no USDC.e
      if (cash < 0.1 && usdcNative > 0) {
          alerts.innerHTML += `<div style="color:orange;margin-bottom:4px">⚠️ Found $${usdcNative.toFixed(2)} Native USDC. You need Bridged USDC.e on Polygon.</div>`;
      }
      
      // Alert 2: Low MATIC
      // Check if we are in Proxy mode (Settings)
      // We'll fetch settings to be sure, or rely on sig_type from cash response if available
      // Ideally backend returns 'is_proxy' or 'signature_type' in /api/cash response.
      // Assuming I can't easily change api_cash response structure blindly (I can, but let's be safe).
      // We will check if the user has a Proxy Address (funder) configured.
      
      const isProxy = (j.funder && j.funder.toLowerCase().startsWith("0x9402")) || (j.signature_type === 1 || j.signature_type === 2);
      
      if (matic < 0.01 && !isProxy) {
          alerts.innerHTML += `<div style="color:red;margin-bottom:4px">⚠️ Low MATIC (${matic.toFixed(4)}). You need MATIC for gas.</div>`;
      }
      
      // Alert 3: Allowance
      // Only for EOA users (sigType 0)
      if (cash > 0 && allowance < 1000 && !isProxy) {
          const btn = document.createElement("button");
          btn.className = "btn small";
          btn.style.width = "100%";
          btn.style.backgroundColor = "#eab308";
          btn.style.color = "#000";
          btn.textContent = "Enable Trading (Approve USDC)";
          btn.onclick = async () => {
              btn.textContent = "Approving...";
              btn.disabled = true;
              try {
                  const res = await fetch("/api/approve", { method: "POST" });
                  const d = await res.json();
                  if (d.success) {
                      alert("Approval Sent! Tx: " + d.txHash);
                      btn.textContent = "Approved!";
                  } else {
                      alert("Error: " + d.error);
                      btn.textContent = "Retry Approve";
                      btn.disabled = false;
                  }
              } catch (e) {
                  alert("Network error");
                  btn.textContent = "Retry Approve";
                  btn.disabled = false;
              }
          };
          alerts.appendChild(btn);
      }
      
    } catch {}
  })();
}

function openAccountOverlay(e) {
  if (e && e.preventDefault) e.preventDefault();
  const addr = getMyAddress();
  const apiKey = getApiKey();
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="overlay-body">
      <div class="overlay-header">
        <div>My Account</div>
        <button class="btn small" id="close-overlay">Close</button>
      </div>
      <div id="positions"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#close-overlay").addEventListener("click", () => overlay.remove());
  (async () => {
    const positions = await fetchJSON("https://data-api.polymarket.com/positions", { user: addr }, apiKey);
    const root = overlay.querySelector("#positions");
    if (!Array.isArray(positions) || positions.length === 0) {
      root.textContent = "No positions";
      return;
    }
    const table = document.createElement("table");
    table.className = "table";
    const thead = document.createElement("thead");
    thead.innerHTML = `
      <tr>
        <th>Market</th>
        <th>Outcome</th>
        <th>Size</th>
        <th>Avg Price</th>
        <th>Current</th>
        <th>P/L</th>
      </tr>
    `;
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const p of positions) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><a target="_blank" href="${p.slug ? `https://polymarket.com/market/${p.slug}` : '#'}">${p.title || ""}</a></td>
        <td>${p.outcome || ""}</td>
        <td>${p.size != null ? Number(p.size).toFixed(2) : ""}</td>
        <td>${p.avgPrice != null ? Number(p.avgPrice).toFixed(3) : ""}</td>
        <td>${p.currentValue != null ? Number(p.currentValue).toFixed(2) : ""}</td>
        <td>${p.cashPnl != null ? Number(p.cashPnl).toFixed(2) : ""}</td>
      `;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    root.innerHTML = "";
    root.appendChild(table);
  })();
}

async function openSettingsModal(e) {
  if (e && e.preventDefault) e.preventDefault();
  
  // Fetch current settings
  let currentSettings = { configured: false, funder: "", signature_type: 0, masked_pk: "" };
  try {
      const res = await fetch("/api/settings");
      if (res.ok) currentSettings = await res.json();
  } catch {}

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="overlay-body">
      <div class="overlay-header">
        <div>Trading Settings</div>
        <button class="btn small" id="close-settings">Close</button>
      </div>
      <div style="margin-bottom:10px;font-size:0.9em;color:#888;">
        Your Private Key is required to place orders. It is saved securely in your local database.
      </div>
      <form id="settings-form" class="settings-form">
        <div style="margin-bottom:8px">
            <label style="display:block;font-size:0.8em;margin-bottom:4px">Private Key (EOA)</label>
            <input type="password" name="private_key" placeholder="${currentSettings.masked_pk ? 'Saved (' + currentSettings.masked_pk + ')' : 'Paste Private Key'}" ${currentSettings.masked_pk ? '' : 'required'}>
        </div>
        
        <div style="margin-bottom:8px">
            <label style="display:block;font-size:0.8em;margin-bottom:4px">Polymarket Address (Proxy)</label>
            <input type="text" name="funder" id="funder-input" placeholder="0x..." value="${currentSettings.funder || ''}">
            <div style="font-size:0.75em;color:#ff9800">
                REQUIRED for Email/Google/Magic users. <br>
                Go to Polymarket -> Wallet -> Copy Address (top right).
            </div>
        </div>
        
        <div style="margin-bottom:8px">
             <label style="display:block;font-size:0.8em;margin-bottom:4px">Wallet Type</label>
             <select name="signature_type" style="width:100%;padding:8px;background:#333;color:#fff;border:1px solid #444;border-radius:4px">
                <option value="0" ${currentSettings.signature_type == 0 ? 'selected' : ''}>EOA (Metamask/Private Key)</option>
                <option value="2" ${currentSettings.signature_type == 2 ? 'selected' : ''}>Polymarket Wallet (Email/Google/Magic)</option>
                <option value="1" ${currentSettings.signature_type == 1 ? 'selected' : ''}>Legacy Proxy</option>
             </select>
        </div>

        <button type="submit" class="btn">Save & Connect</button>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#close-settings").addEventListener("click", () => overlay.remove());
  
  const form = overlay.querySelector("#settings-form");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    
    // Don't send empty PK if it's already saved
    let pk = fd.get("private_key");
    if (!pk && currentSettings.configured) {
        // If user didn't enter a new PK, we can assume they want to keep the old one
        // But the API expects a PK. 
        // We need to tell the user to re-enter it if they want to change settings?
        // Or we can rely on the backend not overwriting if empty? 
        // Backend `set_creds` throws error if PK is missing.
        // So user MUST re-enter PK to save settings.
        if (!pk) {
             alert("Please re-enter your Private Key to save settings.");
             return;
        }
    }
    
    const payload = {
        private_key: pk,
        funder: fd.get("funder"),
        signature_type: Number(fd.get("signature_type") || 0),
    };
    
    try {
        const res = await fetch("/api/set-creds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res.ok) {
          alert("Settings Saved! " + (data.message || ""));
          overlay.remove();
          initAccountBox();
        } else {
          alert("Error: " + data.error);
        }
    } catch (e) {
        alert("Network error: " + e);
    }
  });
}

async function initAccountBox() {
  const addr = getMyAddress();
  const apiKey = getApiKey();
  const summary = addr ? await fetchAccountSummary(addr, apiKey) : null;
  renderAccountBox(summary);
}

function renderTrades(rows) {
  const root = document.getElementById("trades");
  const table = document.createElement("table");
  table.className = "table";
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Time</th>
      <th>Market</th>
      <th>Outcome</th>
      <th>Side</th>
      <th>Size</th>
      <th>Price</th>
      <th>Tx</th>
      <th>Action</th>
    </tr>
  `;
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    const side = (r.side || "").toLowerCase();
    const pillClass = side === "buy" ? "pill buy" : side === "sell" ? "pill sell" : "pill";
    tr.innerHTML = `
      <td><div>${fmtTs(r.timestamp)}</div><div class="muted">${fmtAgo(r.timestamp)}</div></td>
      <td><a target="_blank" href="${r.slug ? `https://polymarket.com/market/${r.slug}` : '#'}">${r.title || ""}</a></td>
      <td>${r.outcome || ""}</td>
      <td><span class="${pillClass}">${r.side || ""}</span></td>
      <td>${r.size != null ? Number(r.size).toFixed(2) : ""}${r.usdc_size != null ? ` <span class='muted'>(${Number(r.usdc_size).toFixed(2)} USDC)</span>` : ""}</td>
      <td>${r.price != null ? Number(r.price).toFixed(3) : ""}</td>
      <td><a class="muted" target="_blank" href="https://polygonscan.com/tx/${r.transaction_hash || r.transactionHash || ''}">view</a></td>
      <td>
          <button class="repeat-btn">Repeat</button>
          <button class="repeat-btn-5" style="margin-left:4px;font-size:0.8em;padding:2px 6px">5 shares</button>
      </td>
    `;
    const btn = tr.querySelector(".repeat-btn");
    if (btn) btn.addEventListener("click", () => repeatTrade(r));
    const btn5 = tr.querySelector(".repeat-btn-5");
    if (btn5) btn5.addEventListener("click", () => repeatTrade(r, 5));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.innerHTML = "";
  root.appendChild(table);
}

function renderRecentTrades(rows) {
  const root = document.getElementById("recent-trades");
  const table = document.createElement("table");
  table.className = "table";
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Time</th>
      <th>Trader</th>
      <th>Market</th>
      <th>Outcome</th>
      <th>Side</th>
      <th>Size</th>
      <th>Price</th>
      <th>Tx</th>
      <th>Action</th>
    </tr>
  `;
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const side = (r.side || "").toLowerCase();
    const pillClass = side === "buy" ? "pill buy" : side === "sell" ? "pill sell" : "pill";
    const name = r.name || r.pseudonym || r.address || r.proxy_wallet || "";
    const seed = r.address || r.proxy_wallet || name || "trader";
    const avatar = normImg(r.profile_image, seed);
    const traderLink = `/trader/${encodeURIComponent(r.proxy_wallet || r.address || "")}`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><div>${fmtTs(r.timestamp)}</div><div class="muted">${fmtAgo(r.timestamp)}</div></td>
      <td><a href="${traderLink}" class="card inline">
            <img src="${avatar}" class="avatar" alt="" onerror="this.src='/static/default-avatar.svg';this.onerror=null;">
            <div class="card-body"><div class="name">${name}</div></div>
          </a></td>
      <td><a target="_blank" href="${r.slug ? `https://polymarket.com/market/${r.slug}` : '#'}">${r.title || ""}</a></td>
      <td>${r.outcome || ""}</td>
      <td><span class="${pillClass}">${r.side || ""}</span></td>
      <td>${r.size != null ? Number(r.size).toFixed(2) : ""}${r.usdc_size != null ? ` <span class='muted'>(${Number(r.usdc_size).toFixed(2)} USDC)</span>` : ""}</td>
      <td>${r.price != null ? Number(r.price).toFixed(3) : ""}</td>
      <td><a class="muted" target="_blank" href="https://polygonscan.com/tx/${r.transaction_hash || r.transactionHash || ''}">view</a></td>
      <td>
          <button class="repeat-btn">Repeat</button>
          <button class="repeat-btn-5" style="margin-left:4px;font-size:0.8em;padding:2px 6px">5 shares</button>
      </td>
    `;
    const btn = tr.querySelector(".repeat-btn");
    if (btn) btn.addEventListener("click", () => repeatTrade(r));
    const btn5 = tr.querySelector(".repeat-btn-5");
    if (btn5) btn5.addEventListener("click", () => repeatTrade(r, 5));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.innerHTML = "";
  root.appendChild(table);
}

async function refresh() {
  const rows = await fetchTrades(address);
  renderTrades(rows);
}

if (typeof address !== "undefined") {
  refresh();
  setInterval(refresh, 30000);
  initAccountBox();
}

async function refreshIndex() {
  const recent = await fetchRecentTrades();
  renderRecentTrades(recent);
}

if (typeof page !== "undefined" && page === "index") {
  (function setupTradingSettings() {
    const container = document.querySelector(".container");
    if (!container) return;
    const h2 = document.createElement("h2");
    h2.textContent = "Trading Settings";
    const form = document.createElement("form");
    form.className = "add-form";
    form.id = "trading-settings";
    form.innerHTML = `
      <input type="password" name="private_key" placeholder="Wallet private key" required>
      <input type="text" name="funder" placeholder="Proxy Address (from Polymarket Dashboard)">
      <select name="signature_type">
        <option value="0">EOA (Metamask/Private Key)</option>
        <option value="2">Polymarket Wallet (Email/Google/Magic)</option>
        <option value="1">Legacy Proxy</option>
      </select>
      <button type="submit">Save</button>
    `;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const payload = {
        private_key: fd.get("private_key"),
        funder: fd.get("funder"),
        signature_type: Number(fd.get("signature_type") || 0),
      };
      try {
        const res = await fetch("/api/set-creds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          alert("Trading settings saved");
        } else {
          const t = await res.text();
          alert("Failed to save settings: " + t);
        }
      } catch {
        alert("Network error saving settings");
      }
    });
    container.insertBefore(form, container.children[2] || null);
    container.insertBefore(h2, form);
  })();
  refreshIndex();
  setInterval(refreshIndex, 20000);
  initAccountBox();
}

function repeatTrade(r, overrideSize = null) {
  const payload = {
    slug: r.slug || "",
    outcome_index: typeof r.outcome_index === "number" ? r.outcome_index : null,
    outcome: r.outcome || null,
    side: r.side || "",
    size: overrideSize != null ? Number(overrideSize) : (r.size != null ? Number(r.size) : null),
    price: r.price != null ? Number(r.price) : null,
    usdc_size: overrideSize != null ? null : (r.usdc_size || null) // Clear usdc_size if overriding size
  };
  (async () => {
    try {
      const res = await fetch("/api/repeat-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data && data.success === false)) {
        const msg = (data && (data.error || data.errorMsg)) || "Failed to place order";
        if (msg.includes("not enough balance") || msg.includes("allowance")) {
            alert(`Order Failed: ${msg}\n\nReason: likely insufficient USDC in your Wallet/Proxy.\nIf you are using a Polymarket Wallet, ensure you have selected 'Polymarket Wallet' in Settings.`);
        } else {
            alert(msg);
        }
        if (msg.includes("missing credentials")) {
            openSettingsModal();
        }
      } else {
        alert(`Order placed. ID: ${data.orderId || data.orderID || "unknown"}`);
      }
    } catch {
      alert("Network error placing order");
    }
  })();
}
