import { supabase } from "./supabaseClient.js";
import { state } from "./state.js";
import { renderWelcome } from "./auth.js";
import { initShell } from "./shell.js";
import { renderAdminHome, renderSales, renderCollab, renderWorkers, renderAdminSettings, renderExpenses, renderAnalytics } from "./admin.js";
import { renderWorkerHome, renderWorkerSettings } from "./worker.js";
import { renderChat, startGlobalMessageWatcher } from "./chat.js";
import { toast } from "./utils.js";

const ADMIN_ROUTES = {
  home: renderAdminHome,
  sales: renderSales,
  expenses: renderExpenses,
  analytics: renderAnalytics,
  collab: renderCollab,
  chat: () => renderChat("chat"),
  workers: renderWorkers,
  settings: renderAdminSettings
};

const WORKER_ROUTES = {
  home: renderWorkerHome,
  chat: () => renderChat("chat"),
  settings: renderWorkerSettings
};

initShell(page => {
  const routes = state.profile.role === "admin" ? ADMIN_ROUTES : WORKER_ROUTES;
  (routes[page] || routes.home)();
});

export async function bootApp() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return renderWelcome();
  state.user = user;

  const { data: profile, error } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (error || !profile) return renderWelcome();
  state.profile = profile;

  const { data: business } = await supabase.from("businesses").select("*").eq("id", profile.business_id).maybeSingle();
  if (!business) { toast("Couldn't load your business — please log in again.", "error"); return renderWelcome(); }
  state.business = business;

  const { data: channels } = await supabase.from("channels").select("id").eq("business_id", business.id);
  state.businessChannelIds = (channels || []).map(c => c.id);
  startGlobalMessageWatcher();

  if (profile.role === "admin") renderAdminHome();
  else renderWorkerHome();
}

bootApp().catch(err => { console.error(err); renderWelcome(); });
