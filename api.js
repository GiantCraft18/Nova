// Общие утилиты для страниц Nova
(function () {
  async function request(path, options = {}) {
    const init = {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: {},
    };
    if (options.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    let response;
    try {
      response = await fetch(path, init);
    } catch {
      throw new Error("Нет связи с сервером. Проверьте, что он запущен.");
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const error = new Error(data?.error || `Ошибка ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function money(kopecks) {
    return `${(kopecks / 100).toLocaleString("ru-RU")} ₽`;
  }

  function date(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  function dateTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // Разрешаем редирект только внутри своего сайта
  function safeNext(value, fallback = "account.html") {
    if (!value) return fallback;
    try {
      const url = new URL(value, window.location.href);
      if (url.origin !== window.location.origin) return fallback;
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return fallback;
    }
  }

  function redirectToLogin(next) {
    const target = safeNext(next, "account.html");
    window.location.href = `login.html?next=${encodeURIComponent(target)}`;
  }

  // Ссылка на оплату должна вести на защищённый домен ЮKassa
  function isTrustedPaymentUrl(value) {
    if (typeof value !== "string" || !value) return false;
    let url;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== "https:") return false;
    return ["yookassa.ru", "yoomoney.ru"].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    );
  }

  function showToast(message, type = "success") {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast toast--${type} toast--visible`;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.classList.remove("toast--visible");
    }, 5000);
  }

  window.Nova = {
    request,
    money,
    date,
    dateTime,
    safeNext,
    redirectToLogin,
    showToast,
    isTrustedPaymentUrl,
  };
})();
