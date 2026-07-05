import { supabase } from "./supabaseClient.js";
import { $, money, fmtDate, toast, distanceMeters, initials } from "./utils.js";
import { state } from "./state.js";
import { mountMain, pageHeader, openModal, closeModal, renderShell } from "./shell.js";
import { ATTENDANCE_RADIUS_METERS } from "./config.js";

let activeStream = null;

export async function renderWorkerHome() {
  renderShell("home");
  mountMain(`${pageHeader("Home", state.business.name)}<div class="empty-state">Loading…</div>`);

  const bizId = state.business.id;
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  const { data: myTxns } = await supabase.from("transactions").select("*, products(name)").eq("business_id", bizId).eq("worker_id", state.profile.id).order("created_at", { ascending: false }).limit(20);
  const { data: products } = await supabase.from("products").select("*").eq("business_id", bizId);
  const { data: openAttendance } = await supabase.from("attendance").select("*").eq("business_id", bizId).eq("worker_id", state.profile.id).is("clock_out", null).order("clock_in", { ascending: false }).limit(1).maybeSingle();

  const todaysSales = (myTxns || []).filter(t => t.type === "sale" && new Date(t.created_at) >= startOfDay).reduce((s, t) => s + Number(t.amount), 0);
  const lowStock = (products || []).filter(p => p.stock <= p.low_stock_threshold);
  const clockedIn = !!openAttendance;
  const canSeeProducts = state.profile.permissions?.products !== false;

  mountMain(`
    ${pageHeader("Home", state.business.name)}
    <div class="grid-2">
      <div class="panel">
        <h3>Attendance</h3>
        <div class="attendance-station">
          <button class="clock-btn ${clockedIn ? "in" : "out"}" id="clock-btn">
            ${clockedIn ? "CLOCK OUT" : "CLOCK IN"}
          </button>
          <div class="status-line" id="clock-status">${clockedIn ? `Clocked in at ${new Date(openAttendance.clock_in).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "You're currently clocked out."}</div>
        </div>
      </div>
      <div class="panel">
        <div class="tag-card" style="margin-bottom:12px;"><div class="tag-label">Today's sales contribution</div><div class="tag-value amber">${money(todaysSales)}</div></div>
        <div class="quick-actions">
          <button class="btn btn-primary" id="qa-sale">+ Add sale</button>
          <button class="btn btn-ghost" id="qa-expense">+ Record expense</button>
        </div>
        ${lowStock.length ? `<div class="panel" style="margin-top:14px;"><h3>Low stock (store-wide)</h3>${lowStock.map(p => `<div class="item-card"><div class="item-main"><div class="name">${p.name}</div><div class="meta">${p.stock} left</div></div><span class="pill low">Low</span></div>`).join("")}</div>` : ""}
      </div>
    </div>
    ${canSeeProducts ? `
    <div class="panel">
      <h3>Inventory</h3>
      ${(products && products.length) ? `<table>
        <thead><tr><th>Product</th><th>Price</th><th>Stock</th></tr></thead>
        <tbody>
          ${products.map(p => `<tr><td>${p.name}${p.sku ? ` <span class="meta">(${p.sku})</span>` : ""}</td><td class="mono">${money(p.price)}</td><td class="mono">${p.stock}${p.stock <= p.low_stock_threshold ? ` <span class="pill low">Low</span>` : ""}</td></tr>`).join("")}
        </tbody>
      </table>` : `<div class="empty-state">No products added yet.</div>`}
    </div>` : ""}
    <div class="panel">
      <h3>My recent activity</h3>
      <table>
        <thead><tr><th>Type</th><th>Item</th><th>Amount</th><th>When</th></tr></thead>
        <tbody>
          ${(myTxns && myTxns.length) ? myTxns.map(t => `
            <tr><td><span class="pill ${t.type}">${t.type}</span></td><td>${t.products?.name || t.note || "—"}</td><td class="mono">${money(t.amount)}</td><td>${fmtDate(t.created_at)}</td></tr>
          `).join("") : `<tr><td colspan="4"><div class="empty-state">Nothing logged yet today.</div></td></tr>`}
        </tbody>
      </table>
    </div>
  `);

  $("#clock-btn").onclick = () => clockedIn ? handleClockOut(openAttendance) : handleClockIn();
  $("#qa-sale").onclick = () => openWorkerSaleModal();
  $("#qa-expense").onclick = () => openWorkerExpenseModal();
}

// ---------- attendance: GPS + simulated face-recognition scan ----------
// The photo never leaves the browser — it's grabbed onto a canvas just long
// enough to run the "analyzing" animation, then thrown away. Nothing is
// uploaded to Supabase storage, per how this feature is meant to work.
function getLocation() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 8000 }
    );
  });
}

// Opens the face-scan modal, runs the webcam + neon-frame + countdown +
// checkmark sequence, and resolves once it's done (or rejects if the person
// cancels / the camera can't be opened). Never stores the photo anywhere.
function openFaceScanModal(actionLabel) {
  return new Promise((resolve, reject) => {
    openModal(`
      <button class="modal-close" id="modal-x">✕</button>
      <h3>${actionLabel}</h3>
      <div class="face-scan-frame">
        <video id="scan-video" autoplay playsinline muted></video>
        <div class="scan-ring"></div>
        <div class="scan-line"></div>
        <div class="scan-check hidden" id="scan-check">✓</div>
      </div>
      <div class="status-line" id="scan-status" style="text-align:center;margin-top:10px;">Starting camera…</div>
      <button class="btn btn-ghost btn-block" id="scan-cancel" style="margin-top:12px;">Cancel</button>
    `);

    const video = $("#scan-video");
    const statusEl = $("#scan-status");
    let cancelled = false;

    $("#modal-x").onclick = () => finishAndClose(true);
    $("#scan-cancel").onclick = () => finishAndClose(true);

    function finishAndClose(wasCancelled) {
      cancelled = wasCancelled;
      stopCamera();
      closeModal();
      if (wasCancelled) reject(new Error("cancelled"));
    }

    (async () => {
      try {
        // release any leftover stream BEFORE requesting a new one
        stopCamera();

        activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
        if (cancelled) return;
        video.srcObject = activeStream;

        await video.play().catch(() => {});
        await waitForVideoReady(video, 6000);
        await waitForNonBlackFrame(video, 2500); // let sensor warm-up finish so the countdown isn't over a black feed
        if (cancelled) return;

        statusEl.textContent = "Position your face in the frame…";
        await sleep(500);
        if (cancelled) return;

        for (let s = 3; s >= 1; s--) {
          if (cancelled) return;
          statusEl.textContent = `Analyzing Face… ${s}`;
          await sleep(1000);
        }
        if (cancelled) return;

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 320; canvas.height = video.videoHeight || 240;
        canvas.getContext("2d").drawImage(video, 0, 0);
        canvas.width = 0; canvas.height = 0;

        statusEl.textContent = "Face verified";
        video.classList.add("hidden");
        $("#scan-check").classList.remove("hidden");
        await sleep(900);
        if (cancelled) return;

        stopCamera();
        closeModal();
        resolve();
      } catch (e) {
        if (!cancelled) {
          const msg = e && e.message === "camera-timeout"
            ? "Camera took too long to start — try again."
            : "Couldn't access your camera — check browser permissions.";
          toast(msg, "error");
          finishAndClose(true);
        }
      }
    })();
  });
}

function waitForVideoReady(video, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
    const timer = setTimeout(() => {
      video.removeEventListener("loadeddata", onReady);
      reject(new Error("camera-timeout"));
    }, timeoutMs);
    function onReady() {
      if (video.videoWidth > 0) {
        clearTimeout(timer);
        video.removeEventListener("loadeddata", onReady);
        resolve();
      }
    }
    video.addEventListener("loadeddata", onReady);
  });
}

function waitForNonBlackFrame(video, maxWaitMs = 2500) {
  return new Promise(resolve => {
    const start = performance.now();
    const canvas = document.createElement("canvas");
    canvas.width = 20; canvas.height = 20;
    const ctx = canvas.getContext("2d");

    function isBright() {
      ctx.drawImage(video, 0, 0, 20, 20);
      const data = ctx.getImageData(0, 0, 20, 20).data;
      let total = 0;
      for (let i = 0; i < data.length; i += 4) total += data[i] + data[i + 1] + data[i + 2];
      return (total / (data.length / 4 * 3)) > 12;
    }

    (function poll() {
      let bright = false;
      try { bright = isBright(); } catch { /* frame not decodable yet, keep polling */ }
      if (bright || performance.now() - start > maxWaitMs) return resolve();
      requestAnimationFrame(poll);
    })();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stopCamera() {
  if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); activeStream = null; }
}

async function handleClockIn() {
  const biz = state.business;
  const needsGPS = biz.location_lat != null && biz.location_lng != null;

  let lat = null, lng = null, withinRange = true;
  if (needsGPS) {
    const loc = await getLocation();
    if (loc) {
      lat = loc.lat; lng = loc.lng;
      const dist = distanceMeters(lat, lng, biz.location_lat, biz.location_lng);
      withinRange = dist <= ATTENDANCE_RADIUS_METERS;
    }
  }

  try {
    await openFaceScanModal("Clock in — face scan");
  } catch { return; } // cancelled

  const { error } = await supabase.from("attendance").insert({
    business_id: state.business.id, worker_id: state.profile.id,
    clock_in: new Date().toISOString(), lat, lng, within_range: withinRange, photo_url: null
  });
  if (error) return toast(error.message, "error");
  toast("Clocked in!", "success"); renderWorkerHome();
}

async function handleClockOut(record) {
  const biz = state.business;
  const needsGPS = biz.location_lat != null && biz.location_lng != null;
  let lat = record.lat, lng = record.lng;
  if (needsGPS) {
    const loc = await getLocation();
    if (loc) { lat = loc.lat; lng = loc.lng; }
  }

  try {
    await openFaceScanModal("Clock out — face scan");
  } catch { return; } // cancelled

  const { error } = await supabase.from("attendance").update({
    clock_out: new Date().toISOString(), lat, lng
  }).eq("id", record.id);
  if (error) return toast(error.message, "error");
  toast("Clocked out — nice work today.", "success");
  renderWorkerHome();
}

// ---------- worker sale (mandatory photo proof) ----------
function openWorkerSaleModal() {
  supabase.from("products").select("*").eq("business_id", state.business.id).then(({ data: products }) => {
    openModal(`
      <button class="modal-close" id="modal-x">✕</button>
      <h3>Add sale</h3>
      <div class="field"><label>Product</label>
        <select id="t-product"><option value="">— custom —</option>
        ${(products || []).map(p => `<option value="${p.id}" data-price="${p.price}">${p.name} (${money(p.price)})</option>`).join("")}
        </select>
      </div>
      <div class="field-row">
        <div class="field"><label>Quantity</label><input id="t-qty" type="number" min="1" value="1"></div>
        <div class="field"><label>Amount</label><input id="t-amount" type="number" step="0.01" min="0"></div>
      </div>
      <div class="field"><label>Customer name (optional)</label><input id="t-customer" placeholder="Walk-in, or who bought it"></div>
      <div class="field"><label>Payment method</label>
        <select id="t-payment"><option>Cash</option><option>Card</option><option>Bank transfer</option><option>E-wallet</option></select>
      </div>
      <div class="field">
        <label>Proof of sale photo (required)</label>
        <input type="file" id="t-photo" accept="image/*" capture="environment">
      </div>
      <button class="btn btn-primary btn-block" id="save-sale">Save sale</button>
    `);
    $("#modal-x").onclick = closeModal;
    const productSel = $("#t-product");
    productSel.onchange = () => { const o = productSel.selectedOptions[0]; if (o?.dataset.price) $("#t-amount").value = o.dataset.price; };
    $("#save-sale").onclick = async () => {
      const amount = parseFloat($("#t-amount").value);
      const file = $("#t-photo").files[0];
      if (!amount || amount <= 0) return toast("Enter a valid amount", "error");
      if (!file) return toast("A proof-of-sale photo is required", "error");
      const path = `sales/${state.profile.id}-${Date.now()}-${file.name}`;
      const { error: upErr } = await supabase.storage.from("smolbiz-media").upload(path, file);
      const photo_url = upErr ? null : supabase.storage.from("smolbiz-media").getPublicUrl(path).data.publicUrl;
      const payload = {
        business_id: state.business.id, type: "sale", amount,
        payment_method: $("#t-payment").value, worker_id: state.profile.id,
        product_id: productSel.value || null, quantity: parseInt($("#t-qty").value) || 1, photo_url,
        customer_name: $("#t-customer").value.trim() || null
      };
      if (payload.product_id) {
        const prod = products.find(p => p.id === payload.product_id);
        if (prod) {
          await supabase.from("products").update({ stock: Math.max(0, prod.stock - payload.quantity) }).eq("id", prod.id);
          payload.cost_at_sale = (Number(prod.cost) || 0) * payload.quantity;
        }
      }
      const { error } = await supabase.from("transactions").insert(payload);
      if (error) return toast(error.message, "error");
      closeModal(); toast("Sale logged", "success"); renderWorkerHome();
    };
  });
}

function openWorkerExpenseModal() {
  openModal(`
    <button class="modal-close" id="modal-x">✕</button>
    <h3>Record expense</h3>
    <div class="field"><label>Amount</label><input id="t-amount" type="number" step="0.01" min="0"></div>
    <div class="field"><label>Note</label><input id="t-note" placeholder="What was this for?"></div>
    <button class="btn btn-primary btn-block" id="save-exp">Save</button>
  `);
  $("#modal-x").onclick = closeModal;
  $("#save-exp").onclick = async () => {
    const amount = parseFloat($("#t-amount").value);
    if (!amount || amount <= 0) return toast("Enter a valid amount", "error");
    const { error } = await supabase.from("transactions").insert({
      business_id: state.business.id, type: "expense", amount,
      note: $("#t-note").value.trim() || null, worker_id: state.profile.id
    });
    if (error) return toast(error.message, "error");
    closeModal(); toast("Expense recorded", "success"); renderWorkerHome();
  };
}

// ---------- settings ----------
export async function renderWorkerSettings() {
  renderShell("settings");
  const p = state.profile;
  mountMain(`
    ${pageHeader("Settings")}
    <div class="panel">
      <h3>Your profile picture</h3>
      <div style="display:flex;align-items:center;gap:16px;">
        <div class="avatar" style="width:64px;height:64px;font-size:20px;overflow:hidden;">
          ${p.avatar_url ? `<img src="${p.avatar_url}" style="width:100%;height:100%;object-fit:cover;">` : initials(p.name)}
        </div>
        <div class="field" style="flex:1;margin:0;"><input id="w-avatar" type="file" accept="image/*"></div>
      </div>
      <button class="btn btn-primary" id="save-avatar" style="margin-top:14px;">Upload picture</button>
    </div>
    <div class="panel">
      <h3>My profile</h3>
      <div class="field"><label>Name</label><input id="w-name" value="${p.name || ""}"></div>
      <div class="field"><label>Phone</label><input id="w-phone" value="${p.phone || ""}"></div>
      <button class="btn btn-primary" id="save-worker">Save changes</button>
    </div>
  `);
  $("#save-avatar").onclick = async () => {
    const file = $("#w-avatar").files[0];
    if (!file) return toast("Choose a picture first", "error");
    const path = `avatars/${p.id}-${Date.now()}-${file.name}`;
    const { error: upErr } = await supabase.storage.from("smolbiz-media").upload(path, file);
    if (upErr) return toast(upErr.message, "error");
    const avatar_url = supabase.storage.from("smolbiz-media").getPublicUrl(path).data.publicUrl;
    await supabase.from("profiles").update({ avatar_url }).eq("id", p.id);
    Object.assign(state.profile, { avatar_url });
    toast("Profile picture updated", "success");
    renderWorkerSettings();
  };
  $("#save-worker").onclick = async () => {
    const payload = { name: $("#w-name").value.trim(), phone: $("#w-phone").value.trim() };
    await supabase.from("profiles").update(payload).eq("id", p.id);
    Object.assign(state.profile, payload);
    toast("Saved", "success");
  };
}
