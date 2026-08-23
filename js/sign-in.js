import { AUTH_CONFIG } from "./core/config.js";
import { AuthService } from "./services/authService.js?v=20260823.10";

let authService = null;

bootstrapSignIn();

async function bootstrapSignIn() {
  try {
    authService = new AuthService();
    if (!(await authService.guardSignIn())) {
      return;
    }

    document.documentElement.classList.remove("auth-pending");
    initializeSignIn();
  } catch (error) {
    window.console.error("Authentication initialization failed.", error);
    document.documentElement.classList.remove("auth-pending");
    initializeSignIn({ unavailableMessage: error.message });
  }
}

function initializeSignIn({ unavailableMessage = "" } = {}) {
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
    setFieldError(usernameInput, usernameIsEmpty ? "Enter your username." : "");
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
    submitButton.disabled = isLoading || Boolean(unavailableMessage);
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
    if (submitting || unavailableMessage || !authService) {
      return;
    }

    clearAuthenticationError();
    if (!validateForm()) {
      return;
    }

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const shouldRememberUsername = rememberInput.checked;
    setLoading(true);

    try {
      if (AUTH_CONFIG.signInDelayMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, AUTH_CONFIG.signInDelayMs));
      }

      const result = await authService.signIn(username, password, {
        rememberUsername: shouldRememberUsername
      });

      if (!result.ok) {
        passwordInput.value = "";
        showAuthenticationError("The username or password is incorrect.");
        showToast("Sign in failed. Please try again.", "error");
        setLoading(false);
        passwordInput.focus();
        return;
      }

      submitLabel.textContent = "Access verified";
      showToast("Access verified. Opening dashboard...", "success");
      window.setTimeout(() => authService.redirect("index.html"), AUTH_CONFIG.redirectDelayMs);
    } catch (error) {
      window.console.error("Sign in request failed.", error);
      passwordInput.value = "";
      showAuthenticationError("Sign in service is temporarily unavailable. Please try again.");
      showToast("Unable to contact the authentication service.", "error");
      setLoading(false);
    }
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
    showToast("Password changes are managed in Supabase Authentication for these accounts.", "info");
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
    const rememberedUsername = authService?.getRememberedUsername() || "";
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

  if (unavailableMessage) {
    showAuthenticationError(unavailableMessage);
    submitButton.disabled = true;
  } else {
    restoreRememberedUsername();
    document.addEventListener("DOMContentLoaded", restoreRememberedUsername, { once: true });
    window.addEventListener("pageshow", restoreRememberedUsername, { once: true });
    window.setTimeout(restoreRememberedUsername, 250);
  }
}
