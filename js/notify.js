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
let audioUnlocked = false;

function getNotifyAudio() {
  if (!notifyAudio) {
    notifyAudio = new Audio("assets/notification.mp3");
    notifyAudio.preload = "auto";
    notifyAudio.volume = 0.55;
  }
  return notifyAudio;
}

// Most browsers (especially Safari/iOS) refuse to play audio with sound
// until the page has seen a real user gesture (click/tap/keypress), and some
// will also throw if you touch `currentTime` before the file has metadata
// loaded. A notification that arrives over the realtime socket is never
// itself a user gesture, so without this the very first play() call (and
// sometimes every call) got silently swallowed by the try/catch below and
// nothing was ever heard. We "unlock" playback once, on the first real
// interaction anywhere on the page, so later notification sounds are free
// to play programmatically.
function unlockAudioOnce() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  const audio = getNotifyAudio();
  const p = audio.play();
  if (p && typeof p.catch === "function") {
    p.then(() => { audio.pause(); audio.currentTime = 0; }).catch(() => { audioUnlocked = false; });
  } else {
    audio.pause();
  }
}
["click", "touchstart", "keydown"].forEach(evt => {
  document.addEventListener(evt, unlockAudioOnce, { once: true, passive: true });
});

export function playNotifySound() {
  if (!isSoundEnabled()) return;
  try {
    const audio = getNotifyAudio();
    // Only reset playback position once the element actually has metadata —
    // setting currentTime before that (readyState 0) throws in some browsers
    // and would otherwise abort play() before it even starts.
    if (audio.readyState > 0) {
      try { audio.currentTime = 0; } catch (e) { /* ignore, play() below still runs */ }
    }
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch(e => console.warn("Notification sound couldn't play (likely needs a user interaction first):", e));
    }
  } catch (e) { console.warn("Notification sound failed:", e); }
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
