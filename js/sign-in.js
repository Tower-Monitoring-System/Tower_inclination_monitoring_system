import { AUTH_CONFIG } from "./core/config.js";
import { AuthService } from "./services/authService.js?v=20260823.9";

const authService = new AuthService();

if (authService.guardSignIn()) {
  document.documentElement.classList.remove("auth-pending");
  initializeSignIn();
}

function initializeSignIn() {
  const form = document.getElementById("signInForm");
  const usernameInput = document.getElementById("username");
  const passwordInput = document.getElementById("password");
  const rememberInput = document.getElementById("rememberUsername");
  const passwordToggle = document.getElementById("passwordToggle");
  const forgotPassword = document.getElementById("forgotPassword");
  const submitButton = document.getElementById("submitButton");
  const submitLabel = submitButton?.querySelector(".button-label");
  const authenticationError = document.getElementById("authenticationError");
  const authenticationErrorText = authenticationError?.querySelector("span");
  const toast = document.getElementById("toast");
  const toastMessage = toast?.querySelector(".toast-message");
  let toastTimer = null;
  let submitting = false;

  if (
    !form ||
    !usernameInput ||
    !passwordInput ||
    !rememberInput ||
    !passwordToggle ||
    !forgotPassword ||
    !submitButton ||
    !submitLabel ||
    !authenticationError ||
    !authenticationErrorText ||
    !toast ||
    !toastMessage
  ) {
    window.console.error("Sign-in initialization failed because required form elements are missing.");
    return;
  }

  function setFieldError(input, message) {
    const fieldGroup = input.closest(".field-group");
    const errorElement = document.getElementById(input.getAttribute("aria-describedby"));
    fieldGroup?.classList.toggle("has-error", Boolean(message));
    input.setAttribute("aria-invalid", message ? "true" : "false");
    if (errorElement) {
      errorElement.textContent = message;
    }
  }

  function clearAuthenticationError() {
    authenticationError.hidden = true;
    authenticationErrorText.textContent = "";
  }

  function showAuthenticationError(message) {
    authenticationErrorText.textContent = message;
    authenticationError.hidden = false;
  }

  function validateForm() {
    const usernameIsEmpty = usernameInput.value.trim().length === 0;
    const passwordIsEmpty = passwordInput.value.length === 0;
    setFieldError(usernameInput, usernameIsEmpty ? "Enter your username or email." : "");
    setFieldError(passwordInput, passwordIsEmpty ? "Enter your password." : "");

    if (usernameIsEmpty) {
      usernameInput.focus();
      return false;
    }
    if (passwordIsEmpty) {
      passwordInput.focus();
      return false;
    }
    return true;
  }

  function setLoading(isLoading) {
    submitting = isLoading;
    submitButton.disabled = isLoading;
    submitButton.classList.toggle("is-loading", isLoading);
    submitButton.setAttribute("aria-busy", isLoading ? "true" : "false");
    submitLabel.textContent = isLoading ? "Signing in..." : "Sign in";
  }

  function showToast(message, type = "info") {
    window.clearTimeout(toastTimer);
    toastMessage.textContent = message;
    toast.classList.toggle("is-error", type === "error");
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3400);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    clearAuthenticationError();
    if (!validateForm()) {
      return;
    }

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const shouldRememberUsername =
      rememberInput.checked || new FormData(form).has("rememberUsername");
    setLoading(true);
    await new Promise((resolve) => window.setTimeout(resolve, AUTH_CONFIG.signInDelayMs));

    if (!authService.authenticate(username, password)) {
      authService.clearSession();
      showAuthenticationError("The username or password is incorrect. Check your credentials and try again.");
      showToast("Sign in failed. Please try again.", "error");
      setLoading(false);
      usernameInput.focus();
      return;
    }

    if (!authService.createSession(username, { rememberUsername: shouldRememberUsername })) {
      showAuthenticationError("A browser session could not be created. Enable browser storage and try again.");
      showToast("Browser storage is unavailable.", "error");
      setLoading(false);
      return;
    }

    submitLabel.textContent = "Access verified";
    showToast("Access verified. Opening dashboard...", "success");
    window.setTimeout(() => authService.redirect("index.html"), AUTH_CONFIG.redirectDelayMs);
  }

  passwordToggle.addEventListener("click", () => {
    const showPassword = passwordInput.type === "password";
    passwordInput.type = showPassword ? "text" : "password";
    passwordToggle.textContent = showPassword ? "Hide" : "Show";
    passwordToggle.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
    passwordToggle.setAttribute("aria-pressed", showPassword ? "true" : "false");
    passwordInput.focus({ preventScroll: true });
  });

  forgotPassword.addEventListener("click", () => {
    showToast("Password recovery will be available when server authentication is connected.", "info");
  });
  usernameInput.addEventListener("input", () => {
    if (usernameInput.value.trim()) {
      setFieldError(usernameInput, "");
    }
    clearAuthenticationError();
  });
  passwordInput.addEventListener("input", () => {
    if (passwordInput.value) {
      setFieldError(passwordInput, "");
    }
    clearAuthenticationError();
  });
  form.addEventListener("submit", handleSubmit);

  function restoreRememberedUsername() {
    const rememberedUsername = authService.getRememberedUsername();
    if (rememberedUsername) {
      if (!usernameInput.value) {
        usernameInput.value = rememberedUsername;
      }
      rememberInput.checked = true;
      if (document.activeElement === document.body || document.activeElement === usernameInput) {
        passwordInput.focus();
      }
    } else if (document.activeElement === document.body) {
      usernameInput.focus();
    }
  }

  restoreRememberedUsername();
  document.addEventListener("DOMContentLoaded", restoreRememberedUsername, { once: true });
  window.addEventListener("pageshow", restoreRememberedUsername, { once: true });
  window.setTimeout(restoreRememberedUsername, 250);
}
