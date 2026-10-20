(function () {
  const { request, money, date, dateTime, redirectToLogin, showToast, isTrustedPaymentUrl } = window.Nova;

  const state = {
    user: null,
    plans: [],
    paymentsEnabled: false,
    projects: [],
    orders: [],
  };

  const elements = {
    userAvatar: document.getElementById("userAvatar"),
    userName: document.getElementById("userName"),
    welcome: document.getElementById("welcome"),
    logoutBtn: document.getElementById("logoutBtn"),
    paymentBanner: document.getElementById("paymentBanner"),
    planBadge: document.getElementById("planBadge"),
    planStatus: document.getElementById("planStatus"),
    planActions: document.getElementById("planActions"),
    projectForm: document.getElementById("projectForm"),
    projectName: document.getElementById("projectName"),
    projectDesc: document.getElementById("projectDesc"),
    projectSubmit: document.getElementById("projectSubmit"),
    projectCount: document.getElementById("projectCount"),
    projectList: document.getElementById("projectList"),
    ordersBody: document.getElementById("ordersBody"),
    ordersEmpty: document.getElementById("ordersEmpty"),
  };

  const STATUS_LABELS = {
    paid: "Оплачен",
    pending: "Ожидает оплаты",
    canceled: "Отменён",
  };

  function renderUser() {
    const { user } = state;
    elements.userAvatar.textContent = (user.name || user.email || "?").trim().charAt(0).toUpperCase();
    elements.userName.textContent = user.name;
    elements.welcome.textContent = `${user.email} · аккаунт создан ${date(user.createdAt)}`;
  }

  function renderSubscription() {
    const { subscription } = state.user;
    elements.planBadge.textContent = subscription.planName;

    if (subscription.planId === "start") {
      elements.planStatus.textContent = `Бесплатный тариф действует бессрочно. Доступно проектов: ${subscription.projectLimit}.`;
    } else {
      elements.planStatus.textContent = `Тариф «${subscription.planName}» активен до ${date(
        new Date(subscription.expiresAt).toISOString()
      )}.`;
    }

    elements.planActions.innerHTML = "";
    state.plans
      .filter((plan) => plan.price > 0)
      .forEach((plan) => {
        const isCurrent = subscription.planId === plan.id;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `btn btn--full ${isCurrent ? "btn--ghost" : "btn--primary"}`;
        button.textContent = `${isCurrent ? "Продлить" : "Перейти на"} «${plan.name}» · ${money(plan.price)}/${
          plan.period
        }`;
        if (!state.paymentsEnabled) {
          button.disabled = true;
          button.title = "Онлайн-оплата не настроена";
        } else {
          button.addEventListener("click", () => buy(plan, button));
        }
        elements.planActions.appendChild(button);
      });

    if (!state.paymentsEnabled) {
      const note = document.createElement("p");
      note.className = "panel__muted";
      note.textContent = "Покупка тарифов станет доступна после настройки ЮKassa.";
      elements.planActions.appendChild(note);
    }
  }

  async function buy(plan, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Создаём заказ…";
    try {
      const data = await request("/api/orders", { method: "POST", body: { planId: plan.id } });
      if (!isTrustedPaymentUrl(data.paymentUrl)) {
        throw new Error("Сервер вернул некорректную ссылку на оплату.");
      }
      button.textContent = "Переходим к оплате…";
      window.location.href = data.paymentUrl;
    } catch (error) {
      showToast(error.message, "error");
      button.disabled = false;
      button.textContent = original;
    }
  }

  function renderProjects() {
    const { projects } = state;
    const limit = state.user.subscription.projectLimit;
    elements.projectCount.textContent = limit === null ? `${projects.length}` : `${projects.length} из ${limit}`;
    elements.projectList.innerHTML = "";

    if (projects.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Пока нет проектов. Создайте первый — это займёт секунду.";
      elements.projectList.appendChild(empty);
      return;
    }

    for (const project of projects) {
      const card = document.createElement("article");
      card.className = "project";

      const info = document.createElement("div");
      info.className = "project__info";

      const title = document.createElement("h3");
      title.textContent = project.name;

      const description = document.createElement("p");
      description.textContent = project.description || "Без описания";

      const meta = document.createElement("time");
      meta.textContent = `Создан ${date(project.createdAt)}`;

      info.append(title, description, meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn--ghost btn--small";
      remove.textContent = "Удалить";
      remove.addEventListener("click", () => removeProject(project, remove));

      card.append(info, remove);
      elements.projectList.appendChild(card);
    }
  }

  function renderOrders() {
    elements.ordersBody.innerHTML = "";
    elements.ordersEmpty.hidden = state.orders.length > 0;

    for (const order of state.orders) {
      const row = document.createElement("tr");

      const created = document.createElement("td");
      created.textContent = dateTime(order.createdAt);

      const plan = document.createElement("td");
      plan.textContent = order.planName;

      const amount = document.createElement("td");
      amount.textContent = money(order.amount);

      const status = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `status status--${order.status}`;
      badge.textContent = STATUS_LABELS[order.status] || order.status;
      status.appendChild(badge);

      const action = document.createElement("td");
      action.className = "orders__action";
      if (order.status === "pending" && order.confirmationUrl) {
        const payLink = document.createElement("a");
        payLink.className = "btn btn--primary btn--small";
        payLink.href = order.confirmationUrl;
        payLink.textContent = "Оплатить";
        action.appendChild(payLink);
      } else if (order.status === "pending") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn--ghost btn--small";
        button.textContent = "Проверить оплату";
        button.addEventListener("click", () => syncOrder(order.id, button));
        action.appendChild(button);
      } else {
        action.textContent = order.paidAt ? `Оплачен ${dateTime(order.paidAt)}` : "—";
      }

      row.append(created, plan, amount, status, action);
      elements.ordersBody.appendChild(row);
    }
  }

  async function syncOrder(orderId, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Проверяем…";
    try {
      const data = await request(`/api/orders/${encodeURIComponent(orderId)}/sync`, { method: "POST" });
      if (data.order.status === "paid") {
        showToast("Оплата прошла — тариф активирован!");
        await refreshAll();
      } else {
        showToast("Платёж пока не подтверждён. Попробуйте через минуту.", "info");
        button.disabled = false;
        button.textContent = original;
      }
    } catch (error) {
      showToast(error.message, "error");
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function removeProject(project, button) {
    if (!window.confirm(`Удалить проект «${project.name}»?`)) return;
    button.disabled = true;
    try {
      await request(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
      showToast("Проект удалён.");
      await loadProjects();
    } catch (error) {
      showToast(error.message, "error");
      button.disabled = false;
    }
  }

  async function loadProjects() {
    const data = await request("/api/projects");
    state.projects = data.projects;
    renderProjects();
  }

  async function refreshAll() {
    const [me, config, projects, orders] = await Promise.all([
      request("/api/me"),
      request("/api/config"),
      request("/api/projects"),
      request("/api/orders"),
    ]);
    state.user = me.user;
    state.plans = config.plans;
    state.paymentsEnabled = config.paymentsEnabled;
    state.projects = projects.projects;
    state.orders = orders.orders;

    renderUser();
    renderSubscription();
    renderProjects();
    renderOrders();
    elements.paymentBanner.hidden = state.paymentsEnabled;
  }

  async function handleQuery() {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("order");
    const planId = params.get("plan");

    if (planId) {
      const plan = state.plans.find((item) => item.id === planId);
      if (plan) {
        showToast(`Тариф «${plan.name}» выбран. Нажмите кнопку оплаты в блоке «Подписка».`, "info");
        elements.planActions.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }

    if (orderId) {
      const order = state.orders.find((item) => item.id === orderId);
      if (!order) {
        showToast("Заказ не найден.", "error");
      } else if (order.status === "paid") {
        showToast("Оплата прошла — тариф активирован!");
      } else if (order.status === "pending") {
        try {
          const data = await request(`/api/orders/${encodeURIComponent(orderId)}/sync`, { method: "POST" });
          if (data.order.status === "paid") {
            showToast("Оплата прошла — тариф активирован!");
            await refreshAll();
          } else {
            showToast("Платёж обрабатывается. Статус обновится в истории платежей.", "info");
          }
        } catch (error) {
          showToast(error.message, "error");
        }
      }
    }

    if (params.get("paid")) {
      showToast("Оплата прошла — тариф активирован!");
    }

    if (window.location.search) {
      window.history.replaceState({}, "", "account.html");
    }
  }
  elements.projectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = elements.projectName.value.trim();
    const description = elements.projectDesc.value.trim();

    if (name.length < 2) {
      showToast("Название проекта должно содержать минимум 2 символа.", "error");
      elements.projectName.focus();
      return;
    }

    elements.projectSubmit.disabled = true;
    elements.projectSubmit.textContent = "Создаём…";
    try {
      await request("/api/projects", { method: "POST", body: { name, description } });
      elements.projectName.value = "";
      elements.projectDesc.value = "";
      showToast("Проект создан.");
      await loadProjects();
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      elements.projectSubmit.disabled = false;
      elements.projectSubmit.textContent = "Создать проект";
    }
  });

  elements.logoutBtn.addEventListener("click", async () => {
    elements.logoutBtn.disabled = true;
    try {
      await request("/api/auth/logout", { method: "POST" });
    } catch {
      // всё равно уводим на главную
    }
    window.location.href = "index.html";
  });

  (async function init() {
    try {
      const me = await request("/api/me");
      state.user = me.user;
    } catch (error) {
      if (error.status === 401) {
        redirectToLogin(`account.html${window.location.search}`);
        return;
      }
      showToast(error.message, "error");
      return;
    }

    try {
      await refreshAll();
      await handleQuery();
    } catch (error) {
      if (error.status === 401) {
        redirectToLogin(`account.html${window.location.search}`);
        return;
      }
      showToast(error.message, "error");
    }
  })();
})();
