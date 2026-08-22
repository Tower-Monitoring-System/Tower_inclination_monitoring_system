(function initializeAuthentication(window, document) {
  "use strict";

  const SESSION_KEY = "tower-monitor.auth-session";
  const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

  function getConfig() {
    return window.TOWER_AUTH_CONFIG || null;
  }

  function readSession() {
    try {
      const value = window.sessionStorage.getItem(SESSION_KEY);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      return null;
    }
  }

  function clearSession() {
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch (error) {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }

  function isAuthenticated() {
    const config = getConfig();
    const session = readSession();

    if (!config || !session || session.version !== 1) {
      return false;
    }

    const age = Date.now() - session.signedInAt;
    const valid =
      session.authenticated === true &&
      session.username === config.username &&
      Number.isFinite(age) &&
      age >= 0 &&
      age < SESSION_DURATION_MS;

    if (!valid) {
      clearSession();
    }

    return valid;
  }

  function createSession(username) {
    const config = getConfig();

    if (!config || username !== config.username) {
      return false;
    }

    try {
      window.sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          version: 1,
          authenticated: true,
          username,
          signedInAt: Date.now()
        })
      );

      return isAuthenticated();
    } catch (error) {
      return false;
    }
  }

  function signOut() {
    clearSession();
    window.location.replace("./sign-in.html");
  }

  window.TowerAuth = Object.freeze({
    clearSession,
    createSession,
    isAuthenticated,
    signOut
  });

  const currentPage = window.location.pathname.split("/").pop().toLowerCase();
  const isSignInPage = currentPage === "sign-in.html";
  const authenticated = isAuthenticated();

  if (isSignInPage && authenticated) {
    window.location.replace("./index.html");
    return;
  }

  if (!isSignInPage && !authenticated) {
    window.location.replace("./sign-in.html");
    return;
  }

  document.documentElement.classList.remove("auth-pending");

  document.addEventListener("DOMContentLoaded", function bindAuthenticationUi() {
    document.querySelectorAll("[data-auth-username]").forEach(function setUsername(element) {
      const session = readSession();
      element.textContent = session && session.username ? session.username : "Operator";
    });

    document.querySelectorAll("[data-action='sign-out']").forEach(function bindSignOut(button) {
      button.addEventListener("click", signOut);
    });
  });
})(window, document);
