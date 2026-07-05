export function $(sel, scope = document) { return scope.querySelector(sel); }
export function $all(sel, scope = document) { return [...scope.querySelectorAll(sel)]; }

export function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(opts).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  children.forEach(c => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return node;
}

export function money(n) {
  const v = Number(n || 0);
  return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(d) {
  const date = new Date(d);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " +
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function fmtTime(d) {
  return new Date(d).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function initials(name) {
  if (!name) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join("");
}

export function uid() {
  return crypto.randomUUID();
}

// haversine distance in meters between two lat/lng points
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function toast(msg, kind = "info") {
  let box = document.getElementById("toast-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "toast-box";
    box.style.cssText = "position:fixed;top:18px;right:18px;z-index:999;display:flex;flex-direction:column;gap:8px;";
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  const bg = kind === "error" ? "#E2564A" : kind === "success" ? "#2AA398" : "#12233F";
  const fg = kind === "info" ? "#F3F8FF" : "#0A1526";
  t.style.cssText = `background:${bg};color:${fg};font-weight:600;padding:11px 16px;border-radius:10px;font-size:13px;font-family:Inter,sans-serif;box-shadow:0 10px 24px -8px rgba(20,40,80,.35);max-width:320px;`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Local, offline fallback "NLP": looks for meeting-style phrases and a time.
// Understands "today", "tomorrow", plain weekday names ("monday"), and
// "next <weekday>" (both mean the nearest upcoming occurrence of that
// weekday, never today even if today happens to be that weekday).
// Returns { title, when: Date } or null. This runs instantly and is also
// used when the Groq call in groq.js is unavailable or fails.
export function parseMeetingIntent(text) {
  const lower = text.toLowerCase();
  if (!/(meeting|call|sync|standup|catch[- ]?up)/.test(lower)) return null;

  const timeMatch = lower.match(/(\d{1,2})(:(\d{2}))?\s*(am|pm)/);
  if (!timeMatch) return null;

  let hour = parseInt(timeMatch[1], 10);
  const minute = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
  const ampm = timeMatch[4];
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  const when = new Date();
  const now = new Date();

  const nextWeekdayMatch = lower.match(/next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  const plainWeekdayMatch = !nextWeekdayMatch && lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);

  if (lower.includes("tomorrow")) {
    when.setDate(when.getDate() + 1);
  } else if (nextWeekdayMatch) {
    const targetDay = WEEKDAYS.indexOf(nextWeekdayMatch[1]);
    let delta = (targetDay - now.getDay() + 7) % 7;
    delta = delta === 0 ? 7 : delta; // "next monday" always means a future monday, never today
    when.setDate(when.getDate() + delta);
  } else if (plainWeekdayMatch) {
    const targetDay = WEEKDAYS.indexOf(plainWeekdayMatch[1]);
    let delta = (targetDay - now.getDay() + 7) % 7;
    delta = delta === 0 ? 7 : delta; // if they name today's weekday, assume they mean next week's
    when.setDate(when.getDate() + delta);
  }

  when.setHours(hour, minute, 0, 0);
  if (when < now && !lower.includes("tomorrow") && !nextWeekdayMatch && !plainWeekdayMatch) {
    when.setDate(when.getDate() + 1);
  }

  const titleMatch = lower.match(/(meeting|call|sync|standup|catch[- ]?up)[^.!?]*/);
  const title = (titleMatch ? titleMatch[0] : "Meeting").replace(/\bat\b.*$/, "").replace(/\bon\b.*$/, "").trim();
  const niceTitle = title.charAt(0).toUpperCase() + title.slice(1);

  return { title: niceTitle || "Meeting", when };
}
