import { SUPABASE_CONFIG } from "../core/supabaseConfig.js";
import { STORAGE_KEYS } from "../core/constants.js";
import { getSupabaseClient } from "./supabaseClient.js";

const DEFAULT_IDENTITY = Object.freeze({
  username: "Operator",
  displayName: "Operator",
  role: "operator"
});
const ALLOWED_ROLES = new Set(["owner", "operator"]);
const DASHBOARD_ENTRY_GRANT_KEY = "tower-monitor.dashboard-entry-grant.v1";
const DASHBOARD_ENTRY_GRANT_LIFETIME_MS = 15000;

export class AuthService {
  constructor(browserWindow = window) {
    this.window = browserWindow;
    this.client = getSupabaseClient();
    this.identity = null;
  }

  readStorage(key) {
    try {
      return this.window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  writeStorage(key, value) {
    try {
      this.window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  removeStorage(key) {
    try {
      this.window.localStorage.removeItem(key);
    } catch {
      // Browser storage may be unavailable in privacy-restricted contexts.
    }
  }

  clearDashboardEntryGrant() {
    try {
      this.window.sessionStorage.removeItem(DASHBOARD_ENTRY_GRANT_KEY);
    } catch {
      // Session storage may be unavailable in privacy-restricted contexts.
    }
  }

  grantDashboardEntry() {
    try {
      this.window.sessionStorage.setItem(
        DASHBOARD_ENTRY_GRANT_KEY,
        JSON.stringify({ expiresAt: Date.now() + DASHBOARD_ENTRY_GRANT_LIFETIME_MS })
      );
      return true;
    } catch {
      return false;
    }
  }

  consumeDashboardEntryGrant() {
    let serializedGrant = null;
    try {
      serializedGrant = this.window.sessionStorage.getItem(DASHBOARD_ENTRY_GRANT_KEY);
      this.window.sessionStorage.removeItem(DASHBOARD_ENTRY_GRANT_KEY);
    } catch {
      return false;
    }

    if (!serializedGrant) {
      return false;
    }

    try {
      const grant = JSON.parse(serializedGrant);
      const now = Date.now();
      return Number.isFinite(grant?.expiresAt) &&
        grant.expiresAt >= now &&
        grant.expiresAt <= now + DASHBOARD_ENTRY_GRANT_LIFETIME_MS;
    } catch {
      return false;
    }
  }

  async clearLocalSession() {
    this.clearDashboardEntryGrant();
    try {
      await this.client.auth.signOut({ scope: "local" });
    } catch (error) {
      this.window.console?.warn("The local authentication session could not be cleared cleanly.", error);
    }
    this.identity = null;
  }

  normalizeUsername(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
  }

  getRememberedUsername() {
    return this.readStorage(STORAGE_KEYS.rememberedUsername) || "";
  }

  rememberUsername(username, shouldRemember) {
    if (shouldRemember) {
      return this.writeStorage(
        STORAGE_KEYS.rememberedUsername,
        this.normalizeUsername(username)
      );
    }

    this.removeStorage(STORAGE_KEYS.rememberedUsername);
    return true;
  }

  async getVerifiedUser() {
    const { data, error } = await this.client.auth.getUser();
    if (error || !data?.user) {
      return null;
    }
    return data.user;
  }

  async loadOwnProfile(userId) {
    const { data, error } = await this.client
      .from("profiles")
      .select("id, username, display_name, role")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      throw new Error("The signed-in profile could not be loaded.", { cause: error });
    }

    if (!data || !ALLOWED_ROLES.has(data.role)) {
      return null;
    }

    return Object.freeze({
      id: data.id,
      username: data.username,
      displayName: data.display_name || data.username,
      role: data.role
    });
  }

  async getAuthenticatedIdentity() {
    const user = await this.getVerifiedUser();
    if (!user) {
      this.identity = null;
      return null;
    }

    const profile = await this.loadOwnProfile(user.id);
    if (!profile) {
      await this.client.auth.signOut({ scope: "local" });
      this.identity = null;
      return null;
    }

    this.identity = profile;
    return profile;
  }

  async signIn(username, password, options = {}) {
    this.clearDashboardEntryGrant();
    const normalizedUsername = this.normalizeUsername(username);
    if (!normalizedUsername || typeof password !== "string" || !password) {
      return { ok: false, reason: "invalid_credentials" };
    }

    const { data, error } = await this.client.functions.invoke(
      SUPABASE_CONFIG.usernameLoginFunction,
      {
        body: {
          username: normalizedUsername,
          password
        }
      }
    );

    if (error) {
      console.error("Supabase username-login failed:", error);
      return { ok: false, reason: "service_error" };
    }
    if (!data?.access_token || !data?.refresh_token) {
      console.error("Supabase login response does not contain a valid session");
      return { ok: false, reason: "invalid_credentials" };
    }

    const { error: setSessionError } = await this.client.auth.setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token
    });

    if (setSessionError) {
      await this.client.auth.signOut({ scope: "local" });
      return { ok: false, reason: "session_error" };
    }

    const identity = await this.getAuthenticatedIdentity();
    if (!identity || this.normalizeUsername(identity.username) !== normalizedUsername) {
      await this.client.auth.signOut({ scope: "local" });
      this.identity = null;
      return { ok: false, reason: "not_authorized" };
    }

    this.rememberUsername(normalizedUsername, Boolean(options.rememberUsername));
    if (!this.grantDashboardEntry()) {
      await this.clearLocalSession();
      return { ok: false, reason: "session_error" };
    }
    return { ok: true, identity };
  }

  async guardDashboard() {
    if (!this.consumeDashboardEntryGrant()) {
      await this.clearLocalSession();
      this.redirect("sign-in.html");
      return null;
    }

    const identity = await this.getAuthenticatedIdentity();
    if (!identity) {
      this.redirect("sign-in.html");
      return null;
    }
    return identity;
  }

  async guardSignIn() {
    await this.clearLocalSession();
    return true;
  }

  getUsername() {
    return this.identity?.displayName || this.identity?.username || DEFAULT_IDENTITY.displayName;
  }

  onAuthStateChange(callback) {
    const { data } = this.client.auth.onAuthStateChange((event, session) => {
      callback(event, session);
    });
    return () => data.subscription.unsubscribe();
  }

  redirect(relativePage) {
    this.window.location.replace(`./${relativePage}`);
  }

  async signOut() {
    await this.clearLocalSession();
    this.redirect("sign-in.html");
  }
}
