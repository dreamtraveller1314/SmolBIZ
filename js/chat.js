import { supabase } from "./supabaseClient.js";
import { $, $all, fmtDate, fmtTime, toast, parseMeetingIntent } from "./utils.js";
import { state } from "./state.js";
import { mountMain, pageHeader, renderShell, openModal, closeModal } from "./shell.js";
import { parseMeetingWithAI } from "./groq.js";
import { markChannelRead, isUnread, playNotifySound, setNavUnreadDot, isSoundEnabled, setSoundEnabled } from "./notify.js";

let tab = "chat"; // "chat" | "calendar"
let channelLastMsgAt = {}; // channelId -> ISO timestamp of most recent message, for unread dots

export async function renderChat(initialTab = "chat") {
  tab = initialTab;
  renderShell("chat");
  await paintChatPage();
}

async function paintChatPage() {
  const isAdmin = state.profile.role === "admin";
  let { data: channels } = await supabase.from("channels").select("*").eq("business_id", state.business.id).order("created_at");
  channels = channels || [];
  if (!state.activeChannelId && channels.length) state.activeChannelId = channels[0].id;
  state.businessChannelIds = channels.map(c => c.id);

  // pull each channel's most recent message so we know which ones are unread
  if (channels.length) {
    const { data: recent } = await supabase
      .from("messages")
      .select("channel_id, created_at")
      .in("channel_id", channels.map(c => c.id))
      .order("created_at", { ascending: false });
    channelLastMsgAt = {};
    (recent || []).forEach(m => {
      if (!channelLastMsgAt[m.channel_id]) channelLastMsgAt[m.channel_id] = m.created_at;
    });
  }

  mountMain(`
    ${pageHeader("Chat & Calendar", "Mention a meeting with a time and it'll land on the calendar automatically")}
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;">
      <button class="btn ${tab === "chat" ? "btn-primary" : "btn-ghost"} btn-sm" id="tab-chat">💬 Chat</button>
      <button class="btn ${tab === "calendar" ? "btn-primary" : "btn-ghost"} btn-sm" id="tab-cal">🗓️ Calendar</button>
    </div>
    <div id="tab-body"></div>
  `);
  $("#tab-chat").onclick = () => { tab = "chat"; paintChatPage(); };
  $("#tab-cal").onclick = () => { tab = "calendar"; paintChatPage(); };

  if (tab === "chat") paintChatTab(channels, isAdmin);
  else paintCalendarTab();
}

function paintChatTab(channels, isAdmin) {
  const body = $("#tab-body");
  body.innerHTML = `
    <div class="chat-wrap">
      <div class="channel-list" id="channel-list">
        ${channels.map(c => `
          <div class="channel-item ${c.id === state.activeChannelId ? "active" : ""}" data-ch="${c.id}">
            <span># ${c.name}</span>
            ${isUnread(c.id, channelLastMsgAt[c.id]) ? `<span class="unread-dot"></span>` : ""}
          </div>`).join("")}
        ${isAdmin ? `<div class="channel-item" id="new-channel" style="color:var(--accent);margin-top:8px;">+ New channel</div>` : ""}
      </div>
      <div class="chat-main">
        <div class="chat-messages" id="chat-messages"><div class="empty-state">Select a channel</div></div>
        <div class="chat-input">
          <input id="chat-text" placeholder="Message the team… try: “Meeting next Monday at 4pm”">
          <button class="btn btn-primary" id="chat-send">Send</button>
        </div>
      </div>
    </div>
  `;
  $all("[data-ch]").forEach(el => el.onclick = () => { state.activeChannelId = el.dataset.ch; paintChatTab(channels, isAdmin); });
  if (isAdmin) $("#new-channel").onclick = () => openNewChannelModal(channels);

  if (state.activeChannelId) loadMessages(state.activeChannelId);

  $("#chat-send").onclick = sendMessage;
  $("#chat-text").onkeydown = (e) => { if (e.key === "Enter") sendMessage(); };
}

async function loadMessages(channelId) {
  const { data: messages } = await supabase.from("messages").select("*, profiles(name)").eq("channel_id", channelId).order("created_at").limit(100);
  renderMessages(messages || []);
  markChannelRead(channelId);
  setNavUnreadDot(false);
  const dot = document.querySelector(`.channel-item[data-ch="${channelId}"] .unread-dot`);
  if (dot) dot.remove();

  // Per-channel subscription keeps the open thread live for *other* people's
  // messages. Our own messages are appended optimistically in sendMessage()
  // instead of waiting on this round trip — that round trip (and, in some
  // Supabase projects, realtime replication not being enabled for the table)
  // was the cause of messages seeming to "not appear" until navigating away
  // and back.
  if (state.chatSubscription) supabase.removeChannel(state.chatSubscription);
  state.chatSubscription = supabase.channel(`messages-${channelId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `channel_id=eq.${channelId}` }, payload => {
      if (payload.new.sender_id === state.profile.id) return; // already rendered optimistically
      appendMessageToDOM(payload.new);
      markChannelRead(channelId);
    })
    .subscribe();
}

function renderMessages(messages) {
  const box = $("#chat-messages");
  if (!box) return;
  box.innerHTML = messages.length ? "" : `<div class="empty-state">No messages yet — say hi 👋</div>`;
  messages.forEach(m => appendMessageToDOM(m, false));
  box.scrollTop = box.scrollHeight;
}

function appendMessageToDOM(m, scroll = true) {
  const box = $("#chat-messages");
  if (!box) return;
  if (box.querySelector(".empty-state")) box.innerHTML = "";
  const mine = m.sender_id === state.profile.id;
  const div = document.createElement("div");
  div.className = `msg ${mine ? "me" : ""}`;
  const senderName = mine ? "You" : (m.profiles?.name || m.senderName || "Teammate");
  div.innerHTML = `${m.isBot ? "🤖 " : ""}${escapeHtml(m.content)}<div class="meta">${senderName} · ${fmtTime(m.created_at || new Date())}</div>`;
  box.appendChild(div);
  if (scroll) box.scrollTop = box.scrollHeight;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

async function sendMessage() {
  const input = $("#chat-text");
  const text = input.value.trim();
  if (!text || !state.activeChannelId) return;
  input.value = "";

  // Render immediately so the sender sees their own message without delay —
  // this is the fix for the "message doesn't appear until you leave and
  // come back" bug, which happened because the UI only ever updated via the
  // realtime subscription round trip.
  appendMessageToDOM({ content: text, sender_id: state.profile.id, created_at: new Date().toISOString() });

  const { error } = await supabase.from("messages").insert({
    channel_id: state.activeChannelId, sender_id: state.profile.id, content: text
  });
  if (error) return toast(error.message, "error");

  // Meeting detection: try Groq first (understands "next Monday", "this
  // Friday afternoon", etc.), fall back to the local regex parser if Groq
  // isn't configured or the call fails — this is the calendar bug fix.
  let intent = await parseMeetingWithAI(text).catch(() => null);
  if (!intent) intent = parseMeetingIntent(text);

  if (intent) {
    const { error: evErr } = await supabase.from("events").insert({
      business_id: state.business.id, channel_id: state.activeChannelId,
      title: intent.title, event_time: intent.when.toISOString(), created_by: state.profile.id
    });
    if (!evErr) {
      const confirmText = `Scheduled "${intent.title}" for ${intent.when.toLocaleString()} and added it to the team calendar.`;
      appendMessageToDOM({ content: confirmText, sender_id: state.profile.id, created_at: new Date().toISOString(), isBot: true });
      await supabase.from("messages").insert({
        channel_id: state.activeChannelId, sender_id: state.profile.id,
        content: confirmText
      });
      toast("Added to calendar", "success");
    }
  }
}

function openNewChannelModal(channels) {
  openModal(`
    <button class="modal-close" id="modal-x">✕</button>
    <h3>New channel</h3>
    <div class="field"><label>Channel name</label><input id="ch-name" placeholder="e.g. Kitchen team"></div>
    <button class="btn btn-primary btn-block" id="create-ch">Create</button>
  `);
  $("#modal-x").onclick = closeModal;
  $("#create-ch").onclick = async () => {
    const name = $("#ch-name").value.trim();
    if (!name) return toast("Channel name is required", "error");
    const { data, error } = await supabase.from("channels").insert({ business_id: state.business.id, name }).select().single();
    if (error) return toast(error.message, "error");
    await supabase.from("channel_members").insert({ channel_id: data.id, profile_id: state.profile.id });
    closeModal(); state.activeChannelId = data.id; paintChatPage();
  };
}

// ================= CALENDAR =================
async function paintCalendarTab() {
  const { data: events } = await supabase.from("events").select("*").eq("business_id", state.business.id).order("event_time");
  const body = $("#tab-body");
  const now = new Date();
  const isAdmin = state.profile.role === "admin";
  const upcoming = (events || []).filter(e => new Date(e.event_time) >= now);
  const past = (events || []).filter(e => new Date(e.event_time) < now);

  // Edit/delete controls only ever render for admins — workers get a
  // read-only calendar, matching the "admin manages, worker just views" rule.
  const eventRow = (e, editable) => `
    <div class="event-row">
      <span class="event-date mono">${fmtDate(e.event_time)}</span>
      <span class="event-title">${e.title}</span>
      ${editable ? `
        <div class="item-actions">
          <button class="icon-btn" data-edit-ev="${e.id}">Edit</button>
          <button class="icon-btn" data-del-ev="${e.id}">Delete</button>
        </div>` : ""}
    </div>`;

  body.innerHTML = `
    <div class="panel">
      <h3>Upcoming</h3>
      ${upcoming.length ? upcoming.map(e => eventRow(e, isAdmin)).join("") : `<div class="empty-state">Nothing scheduled. Mention a meeting in chat to add one.</div>`}
    </div>
    ${past.length ? `<div class="panel"><h3>Past</h3>${past.slice(-10).reverse().map(e => eventRow(e, false)).join("")}</div>` : ""}
  `;
  if (!isAdmin) return;

  $all("[data-edit-ev]").forEach(b => b.onclick = () => openEditEventModal(events.find(e => e.id === b.dataset.editEv)));
  $all("[data-del-ev]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this event?")) return;
    await supabase.from("events").delete().eq("id", b.dataset.delEv);
    toast("Event deleted", "success");
    paintCalendarTab();
  });
}

function openEditEventModal(event) {
  if (!event) return;
  const local = toDatetimeLocalValue(new Date(event.event_time));
  openModal(`
    <button class="modal-close" id="modal-x">✕</button>
    <h3>Edit event</h3>
    <div class="field"><label>Title</label><input id="ev-title" value="${event.title}"></div>
    <div class="field"><label>Date & time</label><input id="ev-time" type="datetime-local" value="${local}"></div>
    <button class="btn btn-primary btn-block" id="save-ev">Save changes</button>
  `);
  $("#modal-x").onclick = closeModal;
  $("#save-ev").onclick = async () => {
    const title = $("#ev-title").value.trim();
    const timeVal = $("#ev-time").value;
    if (!title || !timeVal) return toast("Title and time are required", "error");
    const { error } = await supabase.from("events").update({
      title, event_time: new Date(timeVal).toISOString()
    }).eq("id", event.id);
    if (error) return toast(error.message, "error");
    closeModal(); toast("Event updated", "success"); paintCalendarTab();
  };
}

function toDatetimeLocalValue(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ================= GLOBAL UNREAD WATCHER =================
// Called once from main.js after login so the sidebar's Chat nav item can
// show a dot even while the person is looking at a totally different page.
export function startGlobalMessageWatcher() {
  if (state.globalMsgSubscription) supabase.removeChannel(state.globalMsgSubscription);
  state.globalMsgSubscription = supabase.channel(`biz-watch-${state.business.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, payload => {
      if (payload.new.sender_id === state.profile.id) return;
      if (!state.businessChannelIds.includes(payload.new.channel_id)) return;
      if (payload.new.channel_id === state.activeChannelId && document.getElementById("chat-messages")) {
        return; // already looking at this exact channel — no need to badge it
      }
      playNotifySound();
      setNavUnreadDot(true);
    })
    .subscribe();
}
