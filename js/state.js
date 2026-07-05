// Simple shared, in-memory state for the whole SPA.
export const state = {
  user: null,        // supabase auth user
  profile: null,      // row from profiles
  business: null,     // row from businesses
  onboarding: {        // scratch pad while an admin is signing up
    businessType: null,
    businessName: "",
    logoUrl: "",
    salesPlatform: "",
    monthlyRevenue: "",
    contactEmail: "",
    locationLat: null,
    locationLng: null,
    locationAddress: "",
    invites: []
  },
  activeChannelId: null,
  chatSubscription: null,
  businessChannelIds: [],   // cached channel ids for this business, used for the global unread watcher
  globalMsgSubscription: null
};

export function resetOnboarding() {
  state.onboarding = {
    businessType: null,
    businessName: "",
    logoUrl: "",
    salesPlatform: "",
    monthlyRevenue: "",
    contactEmail: "",
    locationLat: null,
    locationLng: null,
    locationAddress: "",
    invites: []
  };
}
