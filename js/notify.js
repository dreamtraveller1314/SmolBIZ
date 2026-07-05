// Lightweight client-side helpers for unread-chat dots + a notification sound.
// Read state is tracked per-channel in localStorage (per browser/device),
// since we don't have a "read receipts" table in the schema.

const LS_READ_KEY = "smolbiz_last_read_v1";
const LS_SOUND_KEY = "smolbiz_sound_enabled_v1";

function readMap() {
  try { return JSON.parse(localStorage.getItem(LS_READ_KEY) || "{}"); }
  catch { return {}; }
}
function writeMap(map) {
  localStorage.setItem(LS_READ_KEY, JSON.stringify(map));
}

export function markChannelRead(channelId) {
  if (!channelId) return;
  const map = readMap();
  map[channelId] = new Date().toISOString();
  writeMap(map);
}

export function getLastRead(channelId) {
  return readMap()[channelId] || null;
}

export function isUnread(channelId, lastMessageAt) {
  if (!channelId || !lastMessageAt) return false;
  const lastRead = getLastRead(channelId);
  return !lastRead || new Date(lastMessageAt) > new Date(lastRead);
}

export function isSoundEnabled() {
  const v = localStorage.getItem(LS_SOUND_KEY);
  return v === null ? true : v === "1";
}

export function setSoundEnabled(v) {
  localStorage.setItem(LS_SOUND_KEY, v ? "1" : "0");
}

// Plays assets/notification.mp3. We keep one Audio instance around and
// reset its playback position on every call so rapid-fire notifications
// each restart the sound instead of getting dropped mid-play.
let notifyAudio = null;
function getNotifyAudio() {
  if (!notifyAudio) {
    notifyAudio = new Audio("assets/notification.mp3");
    notifyAudio.preload = "auto";
    notifyAudio.volume = 0.55;
  }
  return notifyAudio;
}

export function playNotifySound() {
  if (!isSoundEnabled()) return;
  try {
    const audio = getNotifyAudio();
    audio.currentTime = 0;
    const p = audio.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) { /* ignore — sound is a nice-to-have */ }
}

// Whether the sidebar's "Chat & Calendar" nav item should show a dot.
// Kept in module state (not just the DOM) because renderShell() rebuilds the
// whole sidebar's HTML on every page navigation — a DOM-only flag would get
// wiped the moment the person clicks to another page.
let chatUnreadFlag = false;

export function getChatUnreadFlag() {
  return chatUnreadFlag;
}

// Toggles the little red dot on the sidebar "Chat & Calendar" nav item.
// Updates the DOM directly when the sidebar is already on screen, and always
// updates the underlying flag so a fresh renderShell() picks it up too.
export function setNavUnreadDot(show) {
  chatUnreadFlag = show;
  const navItem = document.querySelector('.nav-item[data-page="chat"] .ic');
  if (!navItem) return;
  let dot = navItem.querySelector(".unread-dot");
  if (show && !dot) {
    dot = document.createElement("span");
    dot.className = "unread-dot";
    navItem.appendChild(dot);
  } else if (!show && dot) {
    dot.remove();
  }
}
