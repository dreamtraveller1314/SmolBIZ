import { $, $all, initials } from "./utils.js";
import { state } from "./state.js";
import { logout } from "./auth.js";
import { getChatUnreadFlag } from "./notify.js";

const ADMIN_NAV = [
  { id: "home", ic: "🏠", label: "Home" },
  { id: "sales", ic: "🧾", label: "Sales & Products" },
  { id: "expenses", ic: "💸", label: "Expenses" },
  { id: "analytics", ic: "📊", label: "Analytics" },
  { id: "collab", ic: "🤝", label: "Collab & Trend" },
  { id: "chat", ic: "💬", label: "Chat & Calendar" },
  { id: "workers", ic: "👥", label: "Worker Management" },
  { id: "settings", ic: "⚙️", label: "Settings" }
];

const WORKER_NAV = [
  { id: "home", ic: "🏠", label: "Home" },
  { id: "chat", ic: "💬", label: "Chat & Calendar" },
  { id: "settings", ic: "⚙️", label: "Settings" }
];

let currentPage = "home";
let onNavigate = () => {};

export function initShell(navigateHandler) {
  onNavigate = navigateHandler;
}

export function renderShell(activePage) {
  currentPage = activePage;
  const isAdmin = state.profile.role === "admin";
  const nav = isAdmin ? ADMIN_NAV : WORKER_NAV;
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="app-shell">
      <div class="sidebar" id="sidebar">
        <div class="brand"><img class="logo-mark" src="assets/logo.png" alt="SmolBiz"> SMOLBIZ</div>
        ${nav.map(n => `<div class="nav-item ${n.id === activePage ? "active" : ""}" data-page="${n.id}">
            <span class="ic">${n.ic}${(n.id === "chat" && getChatUnreadFlag() && activePage !== "chat") ? `<span class="unread-dot"></span>` : ""}</span> ${n.label}
          </div>`).join("")}
        <div class="sidebar-footer">
          <div class="who">
            <div class="avatar">${initials(state.profile.name)}</div>
            <div>
              <div class="name">${state.profile.name || state.profile.email}</div>
              <div class="role">${state.profile.role}</div>
            </div>
          </div>
          <button class="btn btn-ghost btn-block btn-sm" id="logout-btn" style="margin-top:10px;">Log out</button>
        </div>
        <button class="hamburger" id="hamburger">☰ Menu</button>
      </div>
      <div class="main" id="main"></div>
    </div>
  `;
  $all(".nav-item").forEach(item => {
    item.onclick = () => {
      $("#sidebar").classList.remove("open");
      onNavigate(item.dataset.page);
    };
  });
  $("#logout-btn").onclick = logout;
  const hb = $("#hamburger");
  if (hb) hb.onclick = () => $("#sidebar").classList.toggle("open");
}

export function mountMain(html) {
  $("#main").innerHTML = html;
}

export function pageHeader(title, sub = "") {
  return `<div class="main-header"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}</div></div>`;
}

export function openModal(html) {
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.id = "modal-backdrop";
  back.innerHTML = `<div class="modal">${html}</div>`;
  back.onclick = (e) => { if (e.target === back) closeModal(); };
  document.body.appendChild(back);
  return back;
}

export function closeModal() {
  const back = document.getElementById("modal-backdrop");
  if (back) back.remove();
}
