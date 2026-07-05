import { supabase } from "./supabaseClient.js";
import { $, $all, money, fmtDate, toast, initials } from "./utils.js";
import { state } from "./state.js";
import { mountMain, pageHeader, openModal, closeModal, renderShell } from "./shell.js";
import { generateInsight, forecastNextPeriod } from "./groq.js";

// ---------- shared helpers ----------
// Simple 0-100 "business health" score from numbers we already have on hand.
// Not a Groq call itself (keeps it instant/free) — the Groq insight text
// above it is the AI-generated part; this just gives it a quick visual mark.
export function computeHealthScore({ weekSales, lastWeekSales, lowStockCount, productCount, totalProfit }) {
  let score = 60;
  if (lastWeekSales > 0) {
    const change = (weekSales - lastWeekSales) / lastWeekSales;
    score += Math.max(-25, Math.min(25, change * 60));
  } else if (weekSales > 0) score += 10;
  if (totalProfit < 0) score -= 20;
  else if (totalProfit > 0) score += 10;
  if (productCount > 0) {
    const lowRatio = lowStockCount / productCount;
    score -= Math.min(25, lowRatio * 50);
  }
  score = Math.round(Math.max(0, Math.min(100, score)));
  const mark = score >= 75 ? { emoji: "🟢", label: "Healthy" } : score >= 45 ? { emoji: "🟡", label: "Watch" } : { emoji: "🔴", label: "At risk" };
  return { score, ...mark };
}

function healthBadgeHTML(h) {
  return `<div class="health-badge health-${h.label.toLowerCase().replace(" ", "-")}">
    <span class="health-emoji">${h.emoji}</span>
    <span class="health-score">${h.score}</span><span class="health-max">/100</span>
    <span class="health-label">${h.label}</span>
  </div>`;
}

function downloadCSV(filename, header, rows) {
  const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = rows.map(r => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([header.map(csvEscape).join(",") + "\n" + body], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  a.click(); URL.revokeObjectURL(url);
}

// ================= HOME =================
export async function renderAdminHome() {
  renderShell("home");
  mountMain(`${pageHeader("Home", state.business.name)}<div class="empty-state">Loading your dashboard…</div>`);

  const bizId = state.business.id;
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - 6); startOfWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfWeek); startOfLastWeek.setDate(startOfWeek.getDate() - 7);

  const { data: txns } = await supabase.from("transactions").select("*, products(name)").eq("business_id", bizId).order("created_at", { ascending: false });
  const { data: products } = await supabase.from("products").select("*").eq("business_id", bizId);
  const { data: attendanceToday } = await supabase.from("attendance").select("*, profiles(name)").eq("business_id", bizId).gte("clock_in", startOfDay.toISOString());

  const all = txns || [];
  const sales = all.filter(t => t.type === "sale");
  const expenses = all.filter(t => t.type === "expense");
  const todaySales = sales.filter(t => new Date(t.created_at) >= startOfDay).reduce((s, t) => s + Number(t.amount), 0);
  const weekSales = sales.filter(t => new Date(t.created_at) >= startOfWeek).reduce((s, t) => s + Number(t.amount), 0);
  const lastWeekSales = sales.filter(t => new Date(t.created_at) >= startOfLastWeek && new Date(t.created_at) < startOfWeek).reduce((s, t) => s + Number(t.amount), 0);
  const totalProfit = sales.reduce((s, t) => s + Number(t.amount) - Number(t.cost_at_sale || 0), 0) - expenses.reduce((s, t) => s + Number(t.amount), 0);
  const pendingOrders = all.filter(t => t.type === "sale" && (t.note || "").toLowerCase().includes("pending")).length;
  const lowStockItems = (products || []).filter(p => p.stock <= p.low_stock_threshold);

  const productCounts = {};
  sales.forEach(t => { const n = t.products?.name; if (n) productCounts[n] = (productCounts[n] || 0) + t.quantity; });
  const topProduct = Object.entries(productCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // last 14 days of sales for the forecast chart
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i); d.setHours(0, 0, 0, 0);
    const next = new Date(d); next.setDate(d.getDate() + 1);
    const total = sales.filter(t => new Date(t.created_at) >= d && new Date(t.created_at) < next).reduce((s, t) => s + Number(t.amount), 0);
    days.push({ label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), total });
  }
  const { projected } = forecastNextPeriod(days.map(d => d.total));
  const health = computeHealthScore({ weekSales, lastWeekSales, lowStockCount: lowStockItems.length, productCount: (products || []).length, totalProfit });

  mountMain(`
    ${pageHeader("Home", state.business.name)}
    <div class="insight-note loading" id="insight-box">
      <div class="pin">📌</div>
      <div style="flex:1;"><h4>AI insight</h4><p>Reading your latest numbers…</p></div>
      ${healthBadgeHTML(health)}
    </div>
    <div class="kpi-grid">
      <div class="tag-card"><div class="tag-label">Today's sales</div><div class="tag-value amber">${money(todaySales)}</div></div>
      <div class="tag-card"><div class="tag-label">Total profit</div><div class="tag-value ${totalProfit >= 0 ? "teal" : "coral"}">${money(totalProfit)}</div></div>
      <div class="tag-card"><div class="tag-label">Pending orders</div><div class="tag-value">${pendingOrders}</div></div>
      <div class="tag-card"><div class="tag-label">Low stock alerts</div><div class="tag-value ${lowStockItems.length ? "coral" : "teal"}">${lowStockItems.length}</div></div>
    </div>
    <div class="quick-actions">
      <button class="btn btn-primary" id="qa-sale">+ Add sale</button>
      <button class="btn btn-ghost" id="qa-product">+ Add product</button>
      <button class="btn btn-ghost" id="qa-expense">+ Record expense</button>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>Sales forecast — next 7 days</h3>
        <canvas id="forecast-chart" height="160"></canvas>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Attendance today</h3>
          <button class="btn btn-ghost btn-sm" id="export-attendance">Export CSV</button>
        </div>
        ${(attendanceToday && attendanceToday.length) ? attendanceToday.map(a => `
          <div class="item-card">
            <div class="item-main">
              <div class="name">${a.profiles?.name || "Worker"}</div>
              <div class="meta">In ${new Date(a.clock_in).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}${a.clock_out ? " · Out " + new Date(a.clock_out).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : ""}</div>
            </div>
            <span class="pill ${a.within_range === false ? "low" : "ok"}">${a.within_range === false ? "Off-site" : "On-site"}</span>
          </div>`).join("") : `<div class="empty-state">No one has clocked in yet today.</div>`}
      </div>
    </div>
    ${lowStockItems.length ? `
      <div class="panel">
        <h3>Low stock</h3>
        ${lowStockItems.map(p => `<div class="item-card"><div class="item-main"><div class="name">${p.name}</div><div class="meta">${p.stock} left · threshold ${p.low_stock_threshold}</div></div><span class="pill low">Low</span></div>`).join("")}
      </div>` : ""}
  `);

  drawForecastChart(days, projected);

  $("#qa-sale").onclick = () => openTransactionModal("sale", () => renderAdminHome());
  $("#qa-product").onclick = () => openProductModal(null, () => renderAdminHome());
  $("#qa-expense").onclick = () => openTransactionModal("expense", () => renderAdminHome());
  $("#export-attendance").onclick = () => exportAttendanceCSV(attendanceToday || []);

  generateInsight({
    businessName: state.business.name,
    todaySales, weekSales, lastWeekSales, topProduct,
    lowStock: lowStockItems.length
  }).then(text => {
    const box = document.getElementById("insight-box");
    if (box) { box.classList.remove("loading"); box.querySelector("p").textContent = text; }
  });
}

function drawForecastChart(days, projected) {
  const ctx = document.getElementById("forecast-chart");
  if (!ctx || !window.Chart) return;
  const labels = [...days.map(d => d.label), ...projected.map((_, i) => `+${i + 1}d`)];
  const actual = [...days.map(d => d.total), ...Array(projected.length).fill(null)];
  const forecast = [...Array(days.length - 1).fill(null), days[days.length - 1].total, ...projected];
  new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Actual", data: actual, borderColor: "#4FA6F5", backgroundColor: "rgba(79,166,245,.15)", tension: .35, spanGaps: false },
        { label: "Forecast", data: forecast, borderColor: "#4FB0A5", borderDash: [5, 4], tension: .35, spanGaps: false }
      ]
    },
    options: {
      plugins: { legend: { labels: { color: "#6C82A3", font: { family: "Inter" } } } },
      scales: {
        x: { ticks: { color: "#6C82A3", maxRotation: 0, autoSkip: true }, grid: { color: "#E1EBF9" } },
        y: { ticks: { color: "#6C82A3" }, grid: { color: "#E1EBF9" } }
      }
    }
  });
}

function exportAttendanceCSV(rows) {
  const header = "Worker,Clock In,Clock Out,On Site\n";
  const body = rows.map(r => `${(r.profiles?.name || "Worker").replace(/,/g, "")},${r.clock_in || ""},${r.clock_out || ""},${r.within_range === false ? "No" : "Yes"}`).join("\n");
  const blob = new Blob([header + body], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `attendance-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ================= SALES & PRODUCTS =================
export async function renderSales() {
  renderShell("sales");
  mountMain(`${pageHeader("Sales & Products")}<div class="empty-state">Loading…</div>`);

  const bizId = state.business.id;
  const { data: txns } = await supabase.from("transactions").select("*, products(name), profiles(name)").eq("business_id", bizId).order("created_at", { ascending: false }).limit(50);
  const { data: products } = await supabase.from("products").select("*").eq("business_id", bizId).order("created_at", { ascending: false });

  // Profit per row: for a sale, it's amount minus what the product cost us
  // (cost_at_sale is stamped at insert time so later cost edits don't rewrite history).
  // For an expense, the whole amount is a hit to profit.
  const profitOf = (t) => t.type === "sale" ? Number(t.amount) - Number(t.cost_at_sale || 0) : -Number(t.amount);

  mountMain(`
    ${pageHeader("Sales & Products")}
    <div class="quick-actions">
      <button class="btn btn-primary" id="qa-sale">+ Add sale</button>
      <button class="btn btn-ghost" id="qa-expense">+ Record expense</button>
      <button class="btn btn-ghost" id="qa-product">+ Add product</button>
      <button class="btn btn-ghost" id="export-ledger" style="margin-left:auto;">⭳ Export CSV</button>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>Transaction ledger</h3>
        <table>
          <thead><tr><th>Type</th><th>Item</th><th>Customer</th><th>Amount</th><th>Profit</th><th>By</th><th>When</th></tr></thead>
          <tbody>
            ${(txns && txns.length) ? txns.map(t => {
              const p = profitOf(t);
              return `
              <tr>
                <td><span class="pill ${t.type}">${t.type}</span></td>
                <td>${t.products?.name || t.note || "—"}</td>
                <td>${t.customer_name || "—"}</td>
                <td class="mono">${money(t.amount)}</td>
                <td class="mono ${p >= 0 ? "profit-pos" : "profit-neg"}">${p >= 0 ? "+" : "−"}${money(Math.abs(p))}</td>
                <td>${t.profiles?.name || "—"}</td>
                <td>${fmtDate(t.created_at)}</td>
              </tr>`; }).join("") : `<tr><td colspan="7"><div class="empty-state">No transactions logged yet.</div></td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Products</h3></div>
        ${(products && products.length) ? products.map(p => `
          <div class="item-card">
            <div class="item-main">
              <div class="name">${p.name}</div>
              <div class="meta">${money(p.price)} · cost ${money(p.cost || 0)} · ${p.stock} in stock${p.sku ? " · SKU " + p.sku : ""}</div>
            </div>
            <div class="item-actions">
              <button class="icon-btn" data-edit="${p.id}">Edit</button>
              <button class="icon-btn" data-del="${p.id}">Delete</button>
            </div>
          </div>`).join("") : `<div class="empty-state">No products yet — add your first one.</div>`}
      </div>
    </div>
  `);

  $("#qa-sale").onclick = () => openTransactionModal("sale", renderSales);
  $("#qa-expense").onclick = () => openTransactionModal("expense", renderSales);
  $("#qa-product").onclick = () => openProductModal(null, renderSales);
  $("#export-ledger").onclick = () => downloadCSV(
    `transactions-${new Date().toISOString().slice(0, 10)}.csv`,
    ["Type", "Item", "Customer", "Amount", "Profit", "By", "When"],
    (txns || []).map(t => [t.type, t.products?.name || t.note || "", t.customer_name || "", Number(t.amount).toFixed(2), profitOf(t).toFixed(2), t.profiles?.name || "", t.created_at])
  );
  $all("[data-edit]").forEach(b => b.onclick = () => openProductModal(products.find(p => p.id === b.dataset.edit), renderSales));
  $all("[data-del]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this product?")) return;
    await supabase.from("products").delete().eq("id", b.dataset.del);
    renderSales();
  });
}

function openProductModal(product, onDone) {
  const editing = !!product;
  openModal(`
    <button class="modal-close" id="modal-x">✕</button>
    <h3>${editing ? "Edit product" : "Add product"}</h3>
    <div class="field"><label>Name</label><input id="p-name" value="${product?.name || ""}"></div>
    <div class="field-row">
      <div class="field"><label>Price (sale price)</label><input id="p-price" type="number" step="0.01" min="0" value="${product?.price ?? ""}"></div>
      <div class="field"><label>Cost / budget to make or buy it</label><input id="p-cost" type="number" step="0.01" min="0" value="${product?.cost ?? 0}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Stock</label><input id="p-stock" type="number" min="0" value="${product?.stock ?? 0}"></div>
      <div class="field"><label>Low stock alert at</label><input id="p-threshold" type="number" min="0" value="${product?.low_stock_threshold ?? 5}"></div>
    </div>
    <div class="field"><label>SKU (optional)</label><input id="p-sku" value="${product?.sku || ""}"></div>
    <button class="btn btn-primary btn-block" id="save-product">${editing ? "Save changes" : "Add product"}</button>
  `);
  $("#modal-x").onclick = closeModal;
  $("#save-product").onclick = async () => {
    const payload = {
      name: $("#p-name").value.trim(),
      price: parseFloat($("#p-price").value) || 0,
      cost: parseFloat($("#p-cost").value) || 0,
      stock: parseInt($("#p-stock").value) || 0,
      sku: $("#p-sku").value.trim() || null,
      low_stock_threshold: parseInt($("#p-threshold").value) || 5,
      business_id: state.business.id
    };
    if (!payload.name) return toast("Product name is required", "error");
    const { error } = editing
      ? await supabase.from("products").update(payload).eq("id", product.id)
      : await supabase.from("products").insert(payload);
    if (error) return toast(error.message, "error");

    // Buying/making stock costs money — log it as an expense so it hits
    // profit, same as any other cost. For a new product that's the full
    // initial stock; for an edit, only the *added* units (a restock).
    const priorStock = editing ? Number(product.stock || 0) : 0;
    const stockAdded = Math.max(0, payload.stock - priorStock);
    if (stockAdded > 0 && payload.cost > 0) {
      await supabase.from("transactions").insert({
        business_id: state.business.id,
        type: "expense",
        amount: payload.cost * stockAdded,
        category: "Inventory / stock",
        note: `${editing ? "Restocked" : "Initial stock"}: ${payload.name} x${stockAdded}`,
        worker_id: state.profile.id
      });
    }

    closeModal(); toast("Saved", "success"); onDone();
  };
}

const EXPENSE_CATEGORIES = ["Inventory / stock", "Rent", "Utilities", "Marketing", "Wages", "Equipment", "Shipping", "Other"];

export function openTransactionModal(type, onDone) {
  supabase.from("products").select("*").eq("business_id", state.business.id).then(({ data: products }) => {
    openModal(`
      <button class="modal-close" id="modal-x">✕</button>
      <h3>${type === "sale" ? "Add sale" : "Record expense"}</h3>
      ${type === "sale" ? `
        <div class="field"><label>Product</label>
          <select id="t-product"><option value="">— none / custom —</option>
          ${(products || []).map(p => `<option value="${p.id}" data-price="${p.price}" data-cost="${p.cost || 0}">${p.name} (${money(p.price)})</option>`).join("")}
          </select>
        </div>
        <div class="field-row">
          <div class="field"><label>Quantity</label><input id="t-qty" type="number" min="1" value="1"></div>
          <div class="field"><label>Amount</label><input id="t-amount" type="number" step="0.01" min="0"></div>
        </div>
        <div class="field"><label>Customer name (optional)</label><input id="t-customer" placeholder="Walk-in, or who bought it"></div>
      ` : `
        <div class="field"><label>Amount</label><input id="t-amount" type="number" step="0.01" min="0"></div>
        <div class="field"><label>Category</label>
          <select id="t-category">${EXPENSE_CATEGORIES.map(c => `<option>${c}</option>`).join("")}</select>
        </div>
      `}
      <div class="field"><label>Payment method</label>
        <select id="t-payment"><option>Cash</option><option>Card</option><option>Bank transfer</option><option>E-wallet</option></select>
      </div>
      <div class="field"><label>Note (optional)</label><input id="t-note" placeholder="e.g. pending fulfillment"></div>
      <button class="btn btn-primary btn-block" id="save-txn">Save</button>
    `);
    $("#modal-x").onclick = closeModal;
    const productSel = document.getElementById("t-product");
    let selectedCost = 0;
    if (productSel) productSel.onchange = () => {
      const opt = productSel.selectedOptions[0];
      if (opt && opt.dataset.price) document.getElementById("t-amount").value = opt.dataset.price;
      selectedCost = opt ? parseFloat(opt.dataset.cost || 0) : 0;
    };
    $("#save-txn").onclick = async () => {
      const amount = parseFloat($("#t-amount").value);
      if (!amount || amount <= 0) return toast("Enter a valid amount", "error");
      const payload = {
        business_id: state.business.id,
        type,
        amount,
        payment_method: $("#t-payment").value,
        note: $("#t-note").value.trim() || null,
        worker_id: state.profile.id
      };
      if (type === "sale" && productSel) {
        payload.product_id = productSel.value || null;
        payload.quantity = parseInt($("#t-qty").value) || 1;
        payload.customer_name = $("#t-customer").value.trim() || null;
        if (payload.product_id) {
          const prod = products.find(p => p.id === payload.product_id);
          if (prod) {
            await supabase.from("products").update({ stock: Math.max(0, prod.stock - payload.quantity) }).eq("id", prod.id);
            payload.cost_at_sale = (Number(prod.cost) || 0) * payload.quantity;
          }
        }
      } else {
        payload.category = $("#t-category").value;
      }
      const { error } = await supabase.from("transactions").insert(payload);
      if (error) return toast(error.message, "error");
      closeModal(); toast("Saved", "success"); onDone();
    };
  });
}

// ================= COLLAB & TREND =================
export async function renderCollab() {
  renderShell("collab");
  mountMain(`${pageHeader("Collab & Trend", "Discover nearby businesses to team up with")}<div class="empty-state">Loading…</div>`);

  const isAdmin = state.profile.role === "admin";
  const { data: others } = await supabase.from("businesses").select("*").neq("id", state.business.id).limit(9);
  const { data: events } = await supabase.from("events").select("*").eq("business_id", state.business.id).order("event_time", { ascending: true }).limit(8);
  // collab_events is a cross-business table (see migration_v2.sql) — every
  // admin can announce one, and every other business's admin can see it
  // along with the contact email to reach out about teaming up.
  const { data: collabEvents } = await supabase.from("collab_events").select("*, businesses(name, logo_url, contact_email)").order("event_time", { ascending: true }).limit(20);

  const collabTypeFor = (type) => {
    if (type === state.business.business_type) return "Cross-promo bundle";
    return "Product line swap";
  };

  mountMain(`
    ${pageHeader("Collab & Trend", "Discover nearby businesses to team up with")}
    <div class="panel">
      <h3>Suggested collaborations</h3>
      <p class="sub" style="margin-top:-8px;">Your contact email for collab requests: <strong>${state.business.contact_email || "not set — add one in Settings"}</strong></p>
      <div class="collab-grid">
        ${(others && others.length) ? others.map(b => `
          <div class="collab-card">
            <div class="logo">${b.logo_url ? `<img src="${b.logo_url}" style="width:100%;height:100%;border-radius:10px;object-fit:cover;">` : initials(b.name)}</div>
            <div class="biz-name">${b.name}</div>
            <div class="niche">${(b.business_type || "business").replace(/_/g, " ")}</div>
            <span class="collab-tag">${collabTypeFor(b.business_type)}</span>
            ${b.contact_email ? `<div class="meta" style="margin-top:8px;">✉️ <a href="mailto:${b.contact_email}">${b.contact_email}</a></div>` : `<div class="meta" style="margin-top:8px;">No contact email listed yet</div>`}
          </div>`).join("") : `<div class="empty-state">No other businesses on SmolBIZ yet — check back soon.</div>`}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <h3>Collab event announcements</h3>
        ${isAdmin ? `<button class="btn btn-primary btn-sm" id="qa-announce">+ Announce an event</button>` : ""}
      </div>
      <p class="sub" style="margin-top:-8px;">Posted by any business on SmolBIZ, with the contact to reach out to.</p>
      ${(collabEvents && collabEvents.length) ? collabEvents.map(e => `
        <div class="item-card">
          <div class="item-main">
            <div class="name">${e.title} <span class="meta">· ${e.businesses?.name || "A business"}</span></div>
            <div class="meta">${fmtDate(e.event_time)}${e.description ? " — " + e.description : ""}</div>
          </div>
          <div>${e.contact_email ? `<a class="btn btn-ghost btn-sm" href="mailto:${e.contact_email}">✉️ ${e.contact_email}</a>` : ""}
          ${(isAdmin && e.business_id === state.business.id) ? `<button class="icon-btn" data-del-collab="${e.id}" style="margin-left:6px;">Delete</button>` : ""}</div>
        </div>`).join("") : `<div class="empty-state">No collab events announced yet.</div>`}
    </div>
    <div class="panel">
      <h3>Your upcoming events</h3>
      ${(events && events.length) ? events.map(e => `
        <div class="event-row"><span class="event-date mono">${fmtDate(e.event_time)}</span><span>${e.title}</span></div>
      `).join("") : `<div class="empty-state">Nothing scheduled — events mentioned in your chat will show up here automatically.</div>`}
    </div>
  `);

  if (isAdmin) $("#qa-announce").onclick = () => openAnnounceCollabModal(renderCollab);
  $all("[data-del-collab]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this announcement?")) return;
    await supabase.from("collab_events").delete().eq("id", b.dataset.delCollab);
    renderCollab();
  });
}

function openAnnounceCollabModal(onDone) {
  openModal(`
    <button class="modal-close" id="modal-x">✕</button>
    <h3>Announce a collab event</h3>
    <p class="sub" style="margin-top:-8px;">Visible to every business on SmolBIZ, alongside your contact email.</p>
    <div class="field"><label>Title</label><input id="ce-title" placeholder="e.g. Pop-up market this weekend"></div>
    <div class="field"><label>Date & time</label><input id="ce-time" type="datetime-local"></div>
    <div class="field"><label>Description (optional)</label><input id="ce-desc" placeholder="What are you looking for / offering?"></div>
    <div class="field"><label>Contact email</label><input id="ce-email" type="email" value="${state.business.contact_email || ""}"></div>
    <button class="btn btn-primary btn-block" id="save-collab">Announce</button>
  `);
  $("#modal-x").onclick = closeModal;
  $("#save-collab").onclick = async () => {
    const title = $("#ce-title").value.trim();
    const timeVal = $("#ce-time").value;
    const contact_email = $("#ce-email").value.trim();
    if (!title || !timeVal) return toast("Title and date/time are required", "error");
    const { error } = await supabase.from("collab_events").insert({
      business_id: state.business.id, title, description: $("#ce-desc").value.trim() || null,
      event_time: new Date(timeVal).toISOString(), contact_email: contact_email || null, created_by: state.profile.id
    });
    if (error) return toast(error.message, "error");
    closeModal(); toast("Announced to all businesses", "success"); onDone();
  };
}

// ================= WORKER MANAGEMENT =================
export async function renderWorkers() {
  renderShell("workers");
  mountMain(`${pageHeader("Worker Management")}<div class="empty-state">Loading…</div>`);

  const { data: workers } = await supabase.from("profiles").select("*").eq("business_id", state.business.id).eq("role", "worker");
  const { data: pendingInvites } = await supabase.from("invites").select("*").eq("business_id", state.business.id).eq("status", "pending");
  const { data: sales } = await supabase.from("transactions").select("worker_id, amount").eq("business_id", state.business.id).eq("type", "sale");

  const salesByWorker = {};
  (sales || []).forEach(s => { if (s.worker_id) salesByWorker[s.worker_id] = (salesByWorker[s.worker_id] || 0) + Number(s.amount); });

  mountMain(`
    ${pageHeader("Worker Management")}
    <div class="quick-actions"><button class="btn btn-primary" id="qa-invite">+ Invite worker</button></div>
    <div class="panel">
      <h3>Team (${(workers || []).length})</h3>
      ${(workers && workers.length) ? workers.map(w => `
        <div class="item-card">
          <div class="item-main"><div class="name">${w.name || w.email}</div><div class="meta">${w.email} · ${money(salesByWorker[w.id] || 0)} in logged sales</div></div>
          <div class="item-actions">
            <button class="icon-btn" data-perm="${w.id}">Permissions</button>
            <button class="icon-btn" data-promote="${w.id}">Make admin</button>
            <button class="icon-btn" data-del="${w.id}">Remove</button>
          </div>
        </div>`).join("") : `<div class="empty-state">No workers yet — invite your team.</div>`}
    </div>
    <div class="panel">
      <h3>Pending invites</h3>
      ${(pendingInvites && pendingInvites.length) ? pendingInvites.map(i => `
        <div class="item-card"><div class="item-main"><div class="name">${i.name || i.email}</div><div class="meta">${i.email} · waiting to sign up</div></div></div>
      `).join("") : `<div class="empty-state">No pending invites.</div>`}
    </div>
  `);

  $("#qa-invite").onclick = () => openInviteModal(renderWorkers);
  $all("[data-del]").forEach(b => b.onclick = async () => {
    if (!confirm("Remove this worker's access?")) return;
    await supabase.from("profiles").delete().eq("id", b.dataset.del);
    renderWorkers();
  });
  $all("[data-perm]").forEach(b => b.onclick = () => openPermissionsModal(workers.find(w => w.id === b.dataset.perm), renderWorkers));
  $all("[data-promote]").forEach(b => b.onclick = async () => {
    const w = workers.find(w => w.id === b.dataset.promote);
    if (!confirm(`Make ${w?.name || w?.email} an admin? They'll get full access to settings, worker management, and everything else admins can see.`)) return;
    const { error } = await supabase.from("profiles").update({ role: "admin" }).eq("id", b.dataset.promote);
    if (error) return toast(error.message, "error");
    toast("Worker promoted to admin", "success");
    renderWorkers();
  });
}

function openInviteModal(onDone) {
  openModal(`
    <button class="modal-close" id="modal-x">✕</button>
    <h3>Invite a worker</h3>
    <div class="field"><label>Name</label><input id="i-name"></div>
    <div class="field"><label>Email</label><input id="i-email" type="email"></div>
    <button class="btn btn-primary btn-block" id="send-invite">Send invite</button>
  `);
  $("#modal-x").onclick = closeModal;
  $("#send-invite").onclick = async () => {
    const email = $("#i-email").value.trim();
    if (!email) return toast("Email is required", "error");
    const { error } = await supabase.from("invites").insert({ business_id: state.business.id, name: $("#i-name").value.trim(), email });
    if (error) return toast(error.message, "error");
    closeModal(); toast("Invite created — share the signup link with them", "success"); onDone();
  };
}

function openPermissionsModal(worker, onDone) {
  const perms = worker.permissions || { sales: true, products: true };
  openModal(`
    <button class="modal-close" id="modal-x">✕</button>
    <h3>Permissions — ${worker.name || worker.email}</h3>
    <div class="field"><label><input type="checkbox" id="perm-sales" ${perms.sales ? "checked" : ""}> Can log sales</label></div>
    <div class="field"><label><input type="checkbox" id="perm-products" ${perms.products ? "checked" : ""}> Can view products</label></div>
    <button class="btn btn-primary btn-block" id="save-perm">Save</button>
  `);
  $("#modal-x").onclick = closeModal;
  $("#save-perm").onclick = async () => {
    const permissions = { sales: $("#perm-sales").checked, products: $("#perm-products").checked };
    await supabase.from("profiles").update({ permissions }).eq("id", worker.id);
    closeModal(); toast("Permissions updated", "success"); onDone();
  };
}

// ================= SETTINGS =================
const BUSINESS_TYPE_OPTIONS = [
  { value: "food_fashion_handmade", label: "Food, Fashion & Handmade" },
  { value: "digital_products", label: "Digital Products" },
  { value: "services", label: "Services" },
  { value: "others", label: "Others" }
];
const SALES_PLATFORM_OPTIONS = ["in_person", "instagram", "shopee", "lazada", "tiktok_shop", "other"];

export async function renderAdminSettings() {
  renderShell("settings");
  const b = state.business;
  const p = state.profile;
  mountMain(`
    ${pageHeader("Settings")}
    <div class="panel">
      <h3>Your profile picture</h3>
      <div style="display:flex;align-items:center;gap:16px;">
        <div class="avatar" style="width:64px;height:64px;font-size:20px;overflow:hidden;">
          ${p.avatar_url ? `<img src="${p.avatar_url}" style="width:100%;height:100%;object-fit:cover;">` : initials(p.name)}
        </div>
        <div class="field" style="flex:1;margin:0;"><input id="s-avatar" type="file" accept="image/*"></div>
      </div>
      <button class="btn btn-primary" id="save-avatar" style="margin-top:14px;">Upload picture</button>
    </div>
    <div class="panel">
      <h3>Business profile</h3>
      <div class="field"><label>Business name</label><input id="s-name" value="${b.name || ""}"></div>
      <div class="field"><label>Logo</label><input id="s-logo" type="file" accept="image/*"></div>
      <button class="btn btn-primary" id="save-profile">Save changes</button>
    </div>
    <div class="panel">
      <h3>Company setup</h3>
      <p class="sub" style="margin-top:-8px;">Same details you filled in when you registered — update them any time.</p>
      <div class="field"><label>What kind of business is this?</label>
        <select id="s-type">${BUSINESS_TYPE_OPTIONS.map(t => `<option value="${t.value}" ${b.business_type === t.value ? "selected" : ""}>${t.label}</option>`).join("")}</select>
      </div>
      <div class="field-row">
        <div class="field"><label>Sales platform</label>
          <select id="s-platform">${SALES_PLATFORM_OPTIONS.map(v => `<option value="${v}" ${b.sales_platform === v ? "selected" : ""}>${v.replace(/_/g, " ")}</option>`).join("")}</select>
        </div>
        <div class="field"><label>Monthly revenue (approx.)</label><input id="s-revenue" type="number" min="0" value="${b.monthly_revenue || 0}"></div>
      </div>
      <div class="field"><label>Email to contact</label><input id="s-contact-email" type="email" value="${b.contact_email || ""}" placeholder="used on the Collab & Trend tab"></div>
      <div class="field">
        <label>Company location ${b.location_lat != null ? "(set)" : "(not set)"}</label>
        <button type="button" class="btn btn-ghost btn-block" id="s-use-location">📍 ${b.location_lat != null ? "Update" : "Use"} my current location</button>
        <div class="status-line" id="s-loc-status" style="margin-top:6px;">${b.location_lat != null ? `Currently set to (${Number(b.location_lat).toFixed(4)}, ${Number(b.location_lng).toFixed(4)}). Workers need to be nearby to clock in.` : "Not set — attendance won't be checked against a location."}</div>
        ${b.location_lat != null ? `<button type="button" class="btn btn-ghost btn-block" id="s-clear-location" style="margin-top:6px;">Clear location</button>` : ""}
      </div>
      <button class="btn btn-primary" id="save-company">Save company setup</button>
    </div>
    <div class="panel">
      <h3>AI forecast sensitivity</h3>
      <p class="sub" style="margin-top:-6px;">Higher values make the forecast react faster to recent sales swings.</p>
      <div class="field"><input id="s-sensitivity" type="range" min="0.5" max="2" step="0.1" value="${b.forecast_sensitivity || 1}"></div>
      <button class="btn btn-primary" id="save-sensitivity">Save</button>
    </div>
  `);

  $("#save-avatar").onclick = async () => {
    const file = $("#s-avatar").files[0];
    if (!file) return toast("Choose a picture first", "error");
    const path = `avatars/${p.id}-${Date.now()}-${file.name}`;
    const { error: upErr } = await supabase.storage.from("smolbiz-media").upload(path, file);
    if (upErr) return toast(upErr.message, "error");
    const avatar_url = supabase.storage.from("smolbiz-media").getPublicUrl(path).data.publicUrl;
    await supabase.from("profiles").update({ avatar_url }).eq("id", p.id);
    Object.assign(state.profile, { avatar_url });
    toast("Profile picture updated", "success");
    renderAdminSettings();
  };
  $("#save-profile").onclick = async () => {
    const payload = { name: $("#s-name").value.trim() };
    const file = $("#s-logo").files[0];
    if (file) {
      const path = `logos/${state.business.id}-${Date.now()}-${file.name}`;
      const { error } = await supabase.storage.from("smolbiz-media").upload(path, file);
      if (!error) payload.logo_url = supabase.storage.from("smolbiz-media").getPublicUrl(path).data.publicUrl;
    }
    await supabase.from("businesses").update(payload).eq("id", b.id);
    Object.assign(state.business, payload);
    toast("Saved", "success");
  };
  $("#s-use-location").onclick = () => {
    if (!navigator.geolocation) return toast("Geolocation isn't available in this browser", "error");
    $("#s-loc-status").textContent = "Getting location…";
    navigator.geolocation.getCurrentPosition(async pos => {
      const location_lat = pos.coords.latitude, location_lng = pos.coords.longitude;
      const { error } = await supabase.from("businesses").update({ location_lat, location_lng }).eq("id", b.id);
      if (error) return toast(error.message, "error");
      Object.assign(state.business, { location_lat, location_lng });
      toast("Location updated", "success");
      renderAdminSettings();
    }, () => { $("#s-loc-status").textContent = "Couldn't get your location — check browser permissions."; });
  };
  const clearLocBtn = $("#s-clear-location");
  if (clearLocBtn) clearLocBtn.onclick = async () => {
    if (!confirm("Clear the company location? Workers will no longer be checked for proximity when clocking in.")) return;
    const { error } = await supabase.from("businesses").update({ location_lat: null, location_lng: null }).eq("id", b.id);
    if (error) return toast(error.message, "error");
    Object.assign(state.business, { location_lat: null, location_lng: null });
    toast("Location cleared", "success");
    renderAdminSettings();
  };
  $("#save-company").onclick = async () => {
    const payload = {
      business_type: $("#s-type").value,
      sales_platform: $("#s-platform").value,
      monthly_revenue: parseFloat($("#s-revenue").value) || 0,
      contact_email: $("#s-contact-email").value.trim() || null
    };
    const { error } = await supabase.from("businesses").update(payload).eq("id", b.id);
    if (error) return toast(error.message, "error");
    Object.assign(state.business, payload);
    toast("Company setup saved", "success");
  };
  $("#save-sensitivity").onclick = async () => {
    const forecast_sensitivity = parseFloat($("#s-sensitivity").value);
    await supabase.from("businesses").update({ forecast_sensitivity }).eq("id", b.id);
    state.business.forecast_sensitivity = forecast_sensitivity;
    toast("Saved", "success");
  };
}

// ================= EXPENSES =================
export async function renderExpenses() {
  renderShell("expenses");
  mountMain(`${pageHeader("Expenses", "Where the money's going, by category")}<div class="empty-state">Loading…</div>`);

  const { data: expenses } = await supabase.from("transactions").select("*").eq("business_id", state.business.id).eq("type", "expense").order("created_at", { ascending: false });
  const rows = expenses || [];
  const byCategory = {};
  rows.forEach(t => { const c = t.category || "Uncategorized"; byCategory[c] = (byCategory[c] || 0) + Number(t.amount); });
  const total = rows.reduce((s, t) => s + Number(t.amount), 0);
  const categories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);

  mountMain(`
    ${pageHeader("Expenses", "Where the money's going, by category")}
    <div class="quick-actions"><button class="btn btn-primary" id="qa-expense">+ Record expense</button></div>
    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="tag-card"><div class="tag-label">Total expenses</div><div class="tag-value coral">${money(total)}</div></div>
      <div class="tag-card"><div class="tag-label">Categories used</div><div class="tag-value">${categories.length}</div></div>
      <div class="tag-card"><div class="tag-label">Transactions</div><div class="tag-value">${rows.length}</div></div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h3>By category</h3>
        <canvas id="expense-chart" height="220"></canvas>
      </div>
      <div class="panel">
        <h3>Recent expenses</h3>
        ${rows.length ? rows.slice(0, 15).map(t => `
          <div class="item-card">
            <div class="item-main"><div class="name">${t.note || t.category || "Expense"}</div><div class="meta">${t.category || "Uncategorized"} · ${fmtDate(t.created_at)}</div></div>
            <span class="mono profit-neg">−${money(t.amount)}</span>
          </div>`).join("") : `<div class="empty-state">No expenses recorded yet.</div>`}
      </div>
    </div>
  `);

  $("#qa-expense").onclick = () => openTransactionModal("expense", renderExpenses);

  const ctx = document.getElementById("expense-chart");
  if (ctx && window.Chart && categories.length) {
    new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: categories.map(c => c[0]),
        datasets: [{ data: categories.map(c => c[1]), backgroundColor: ["#4FA6F5", "#4FB0A5", "#E8735D", "#C9A24F", "#9B7FE0", "#4FC0E0", "#E0894F", "#7FA6E0"] }]
      },
      options: { plugins: { legend: { position: "bottom", labels: { color: "#6C82A3", font: { family: "Inter" } } } } }
    });
  }
}

// ================= ANALYTICS =================
export async function renderAnalytics() {
  renderShell("analytics");
  mountMain(`${pageHeader("Analytics", "How the business is doing, in plain language")}<div class="empty-state">Loading…</div>`);

  const bizId = state.business.id;
  const now = new Date();
  const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - 6); startOfWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfWeek); startOfLastWeek.setDate(startOfWeek.getDate() - 7);

  const { data: txns } = await supabase.from("transactions").select("*").eq("business_id", bizId);
  const { data: products } = await supabase.from("products").select("*").eq("business_id", bizId);
  const all = txns || [];
  const sales = all.filter(t => t.type === "sale");
  const expenses = all.filter(t => t.type === "expense");
  const weekSales = sales.filter(t => new Date(t.created_at) >= startOfWeek).reduce((s, t) => s + Number(t.amount), 0);
  const lastWeekSales = sales.filter(t => new Date(t.created_at) >= startOfLastWeek && new Date(t.created_at) < startOfWeek).reduce((s, t) => s + Number(t.amount), 0);
  const totalProfit = sales.reduce((s, t) => s + Number(t.amount) - Number(t.cost_at_sale || 0), 0) - expenses.reduce((s, t) => s + Number(t.amount), 0);
  const lowStockItems = (products || []).filter(p => p.stock <= p.low_stock_threshold);
  const change = lastWeekSales > 0 ? (((weekSales - lastWeekSales) / lastWeekSales) * 100).toFixed(0) : null;

  const health = computeHealthScore({ weekSales, lastWeekSales, lowStockCount: lowStockItems.length, productCount: (products || []).length, totalProfit });

  const productCounts = {};
  sales.forEach(t => { if (t.product_id) productCounts[t.product_id] = (productCounts[t.product_id] || 0) + t.quantity; });
  const topProducts = Object.entries(productCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id, qty]) => ({ name: (products || []).find(p => p.id === id)?.name || "Unknown", qty }));

  mountMain(`
    ${pageHeader("Analytics", "How the business is doing, in plain language")}
    <div class="insight-note" style="align-items:center;">
      <div class="pin">📊</div>
      <div style="flex:1;">
        <h4>Business health score</h4>
        <p>${change === null ? "Not enough history yet to compare week over week." : `Sales are ${change >= 0 ? "up" : "down"} ${Math.abs(change)}% versus last week.`} ${totalProfit >= 0 ? "You're currently profitable overall." : "You're currently running at a loss overall — worth a closer look at expenses."} ${lowStockItems.length ? `${lowStockItems.length} product(s) are low on stock.` : "Stock levels look fine."}</p>
      </div>
      ${healthBadgeHTML(health)}
    </div>
    <div class="kpi-grid">
      <div class="tag-card"><div class="tag-label">This week's sales</div><div class="tag-value amber">${money(weekSales)}</div></div>
      <div class="tag-card"><div class="tag-label">Total profit</div><div class="tag-value ${totalProfit >= 0 ? "teal" : "coral"}">${money(totalProfit)}</div></div>
      <div class="tag-card"><div class="tag-label">Week-over-week</div><div class="tag-value">${change === null ? "n/a" : (change >= 0 ? "+" : "") + change + "%"}</div></div>
      <div class="tag-card"><div class="tag-label">Low stock</div><div class="tag-value ${lowStockItems.length ? "coral" : "teal"}">${lowStockItems.length}</div></div>
    </div>
    <div class="panel">
      <h3>Top products by units sold</h3>
      ${topProducts.length ? topProducts.map(p => `<div class="item-card"><div class="item-main"><div class="name">${p.name}</div></div><span class="mono">${p.qty} sold</span></div>`).join("") : `<div class="empty-state">No sales logged yet.</div>`}
    </div>
    <div class="panel">
      <h3>Notes</h3>
      <p class="sub">Health score blends your week-over-week sales trend, overall profit, and how much of your catalog is running low on stock. It's a quick gut-check, not a substitute for reading the ledger.</p>
    </div>
  `);
}
