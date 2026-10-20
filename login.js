(function () {
  const { request, safeNext, showToast } = window.Nova;

  const params = new URLSearchParams(window.location.search);
  const plan = ["pro", "business"].includes(params.get("plan")) ? params.get("plan") : "";
  let next = safeNext(params.get("next"), plan ? `account.html?plan=${plan}` : "account.html");
  if (plan && !next.includes("plan=")) {
    next += `${next.includes("?") ? "&" : "?"}plan=${plan}`;
  }

  const form = document.getElementById("authForm");
  const nameField = document.getElementById("name");
  const emailField = document.getElementById("email");
  const passwordField = document.getElementById("password");
  const submitBtn = document.getElementById("submitBtn");
  const errorBox = document.getElementById("authError");
  const title = document.getElementById("authTitle");
  const subtitle = document.getElementById("authSubtitle");
  const hint = document.getElementById("authHint");
  const tabs = Array.from(document.querySelectorAll(".tab"));

  let mode = params.get("mode") === "register" || plan ? "register" : "login";

  function setMode(nextMode) {
    mode = nextMode;
    tabs.forEach((tab) => tab.classList.toggle("tab--active", tab.dataset.mode === mode));
    document.querySelectorAll(".field--register").forEach((field) => {
      field.hidden = mode !== "register";
    });
    title.textContent = mode === "register" ? "Создайте аккаунт" : "Вход в Nova";
    subtitle.textContent =
      mode === "register"
        ? "Бесплатный тариф «Старт» подключается сразу."
        : "Введите email и пароль, чтобы продолжить.";
    submitBtn.textContent = mode === "register" ? "Создать аккаунт" : "Войти";
    passwordField.autocomplete = mode === "register" ? "new-password" : "current-password";
    hint.innerHTML =
      mode === "register"
        ? 'Уже есть аккаунт? <button type="button" class="link-btn" data-mode="login">Войти</button>'
        : 'Нет аккаунта? <button type="button" class="link-btn" data-mode="register">Зарегистрироваться</button>';
    hint.querySelectorAll("[data-mode]").forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.mode));
    });
    hideError();
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function hideError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));

  if (params.get("email")) {
    emailField.value = params.get("email").slice(0, 254);
  }

  setMode(mode);

  // Если пользователь уже вошёл — сразу в кабинет
  request("/api/me")
    .then(() => {
      window.location.replace(next);
    })
    .catch(() => {});

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideError();

    const name = nameField.value.trim();
    const email = emailField.value.trim();
    const password = passwordField.value;

    if (mode === "register" && (name.length < 2 || name.length > 60)) {
      showError("Введите имя от 2 до 60 символов.");
      nameField.focus();
      return;
    }
    if (!email) {
      showError("Введите email.");
      emailField.focus();
      return;
    }
    if (password.length < 8) {
      showError("Пароль должен содержать минимум 8 символов.");
      passwordField.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = mode === "register" ? "Создаём аккаунт…" : "Входим…";

    try {
      if (mode === "register") {
        await request("/api/auth/register", { method: "POST", body: { name, email, password } });
        showToast("Аккаунт создан. Добро пожаловать в Nova!");
      } else {
        await request("/api/auth/login", { method: "POST", body: { email, password } });
      }
      window.location.href = next;
    } catch (error) {
      showError(error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = mode === "register" ? "Создать аккаунт" : "Войти";
    }
  });
})();
