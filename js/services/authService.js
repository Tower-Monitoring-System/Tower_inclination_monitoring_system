import { AUTH_CONFIG } from "../core/config.js";
import { STORAGE_KEYS } from "../core/constants.js";

export class AuthService {
  constructor(config = AUTH_CONFIG, browserWindow = window) {
    this.config = config;
    this.window = browserWindow;
  }

  readStorage(key) {
    try {
      return this.window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  writeStorage(key, value) {
    try {
      this.window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  removeStorage(key) {
    try {
      this.window.localStorage.removeItem(key);
    } catch (error) {
      // Storage may be unavailable in privacy-restricted browser contexts.
    }
  }

  readSession() {
    const rawSession = this.readStorage(STORAGE_KEYS.session);

    if (!rawSession) {
      return null;
    }

    try {
      return JSON.parse(rawSession);
    } catch (error) {
      this.removeStorage(STORAGE_KEYS.session);
      return null;
    }
  }

  clearSession() {
    const session = this.readSession();
    const rememberedUsername = this.readStorage(STORAGE_KEYS.rememberedUsername);
    const username = rememberedUsername || (session?.rememberUsername ? session.username : "");

    if (username) {
      this.writeStorage(
        STORAGE_KEYS.session,
        JSON.stringify({
          version: 1,
          authenticated: false,
          username,
          rememberUsername: true,
          signedInAt: 0
        })
      );
      return;
    }

    this.removeStorage(STORAGE_KEYS.session);
  }

  isAuthenticated() {
    const session = this.readSession();

    if (!session || session.version !== 1) {
      return false;
    }

    if (session.authenticated !== true) {
      return false;
    }

    const age = Date.now() - session.signedInAt;
    const valid =
      session.authenticated === true &&
      session.username === this.config.username &&
      Number.isFinite(age) &&
      age >= 0 &&
      age < this.config.sessionDurationMs;

    if (!valid) {
      this.clearSession();
    }

    return valid;
  }

  authenticate(username, password) {
    return username === this.config.username && password === this.config.password;
  }

  createSession(username, options = {}) {
    if (username !== this.config.username) {
      return false;
    }

    const saved = this.writeStorage(
      STORAGE_KEYS.session,
      JSON.stringify({
        version: 1,
        authenticated: true,
        username,
        rememberUsername: Boolean(options.rememberUsername),
        signedInAt: Date.now()
      })
    );

    if (saved) {
      this.rememberUsername(username, Boolean(options.rememberUsername));
    }

    return saved && this.isAuthenticated();
  }

  signIn(username, password, options = {}) {
    if (!this.authenticate(username, password)) {
      this.clearSession();
      return false;
    }

    return this.createSession(username, options);
  }

  getUsername() {
    return this.readSession()?.username || "Operator";
  }

  getRememberedUsername() {
    const rememberedUsername = this.readStorage(STORAGE_KEYS.rememberedUsername);
    if (rememberedUsername) {
      return rememberedUsername;
    }

    const session = this.readSession();
    return session?.rememberUsername && session.username ? session.username : "";
  }

  rememberUsername(username, shouldRemember) {
    if (shouldRemember) {
      return this.writeStorage(STORAGE_KEYS.rememberedUsername, username);
    }

    this.removeStorage(STORAGE_KEYS.rememberedUsername);
    return true;
  }

  redirect(relativePage) {
    this.window.location.replace(`./${relativePage}`);
  }

  guardDashboard() {
    if (!this.isAuthenticated()) {
      this.redirect("sign-in.html");
      return false;
    }

    return true;
  }

  guardSignIn() {
    if (this.isAuthenticated()) {
      this.redirect("index.html");
      return false;
    }

    return true;
  }

  signOut() {
    const session = this.readSession();
    if (session?.rememberUsername && session.username) {
      this.rememberUsername(session.username, true);
    }
    this.clearSession();
    this.redirect("sign-in.html");
  }
}
