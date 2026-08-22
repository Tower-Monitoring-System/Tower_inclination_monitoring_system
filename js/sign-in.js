(function initializeSignIn(window, document) {
  "use strict";

  const REMEMBERED_USERNAME_KEY = "tower-monitor.remembered-username";
  const form = document.getElementById("signInForm");
  const usernameInput = document.getElementById("username");
  const passwordInput = document.getElementById("password");
  const rememberInput = document.getElementById("rememberUsername");
  const passwordToggle = document.getElementById("passwordToggle");
  const forgotPassword = document.getElementById("forgotPassword");
  const submitButton = document.getElementById("submitButton");
  const submitLabel = submitButton.querySelector(".button-label");
  const authenticationError = document.getElementById("authenticationError");
  const authenticationErrorText = authenticationError.querySelector("span");
  const toast = document.getElementById("toast");
  const toastMessage = toast.querySelector(".toast-message");
  let toastTimer;

  function authenticateUser(username, password) {
    const config = window.TOWER_AUTH_CONFIG;

    return Boolean(
      config &&
      username === config.username &&
      password === config.password
    );
  }

  function setFieldError(input, message) {
    const fieldGroup = input.closest(".field-group");
    const errorElement = document.getElementById(input.getAttribute("aria-describedby"));

    fieldGroup.classList.toggle("has-error", Boolean(message));
    input.setAttribute("aria-invalid", message ? "true" : "false");
    errorElement.textContent = message;
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

    setFieldError(
      usernameInput,
      usernameIsEmpty ? "Enter your username or email." : ""
    );
    setFieldError(
      passwordInput,
      passwordIsEmpty ? "Enter your password." : ""
    );

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
    submitButton.disabled = isLoading;
    submitButton.classList.toggle("is-loading", isLoading);
    submitButton.setAttribute("aria-busy", isLoading ? "true" : "false");
    submitLabel.textContent = isLoading ? "Signing in..." : "Sign in";
  }

  function showToast(message, type) {
    window.clearTimeout(toastTimer);
    toastMessage.textContent = message;
    toast.classList.toggle("is-error", type === "error");
    toast.classList.add("is-visible");

    toastTimer = window.setTimeout(function hideToast() {
      toast.classList.remove("is-visible");
    }, 3400);
  }

  function readRememberedUsername() {
    try {
      return window.localStorage.getItem(REMEMBERED_USERNAME_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function updateRememberedUsername() {
    try {
      if (rememberInput.checked) {
        window.localStorage.setItem(REMEMBERED_USERNAME_KEY, usernameInput.value);
      } else {
        window.localStorage.removeItem(REMEMBERED_USERNAME_KEY);
      }
    } catch (error) {
      // Remember me is optional when local storage is unavailable.
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    clearAuthenticationError();

    if (!validateForm()) {
      return;
    }

    setLoading(true);

    window.setTimeout(function completeAuthentication() {
      const isValid = authenticateUser(usernameInput.value, passwordInput.value);

      if (!isValid) {
        window.TowerAuth.clearSession();
        showAuthenticationError(
          "The username or password is incorrect. Check your credentials and try again."
        );
        showToast("Sign in failed. Please try again.", "error");
        setLoading(false);
        usernameInput.focus();
        return;
      }

      updateRememberedUsername();

      if (!window.TowerAuth.createSession(usernameInput.value)) {
        showAuthenticationError(
          "A secure browser session could not be created. Enable browser storage and try again."
        );
        showToast("Browser storage is unavailable.", "error");
        setLoading(false);
        return;
      }

      submitLabel.textContent = "Access verified";
      showToast("Access verified. Opening dashboard...", "success");

      window.setTimeout(function openDashboard() {
        window.location.replace("./index.html");
      }, 420);
    }, 480);
  }

  passwordToggle.addEventListener("click", function togglePasswordVisibility() {
    const showPassword = passwordInput.type === "password";
    passwordInput.type = showPassword ? "text" : "password";
    passwordToggle.textContent = showPassword ? "Hide" : "Show";
    passwordToggle.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
    passwordToggle.setAttribute("aria-pressed", showPassword ? "true" : "false");
    passwordInput.focus({ preventScroll: true });
  });

  forgotPassword.addEventListener("click", function handleForgotPassword() {
    showToast(
      "Password recovery will be available when server authentication is connected.",
      "info"
    );
  });

  usernameInput.addEventListener("input", function clearUsernameError() {
    if (usernameInput.value.trim()) {
      setFieldError(usernameInput, "");
    }
    clearAuthenticationError();
  });

  passwordInput.addEventListener("input", function clearPasswordError() {
    if (passwordInput.value) {
      setFieldError(passwordInput, "");
    }
    clearAuthenticationError();
  });

  const rememberedUsername = readRememberedUsername();
  if (rememberedUsername) {
    usernameInput.value = rememberedUsername;
    rememberInput.checked = true;
    passwordInput.focus();
  } else {
    usernameInput.focus();
  }

  window.authenticateUser = authenticateUser;
  form.addEventListener("submit", handleSubmit);
})(window, document);
