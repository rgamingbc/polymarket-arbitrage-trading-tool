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
    `;
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
    `;
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
}

async function refreshIndex() {
  const recent = await fetchRecentTrades();
  renderRecentTrades(recent);
}

if (typeof page !== "undefined" && page === "index") {
  refreshIndex();
  setInterval(refreshIndex, 20000);
}
