const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

// ---------- Мок API ЮKassa ----------
const payments = new Map();
let lastAuth = "";

const mockYookassa = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    lastAuth = req.headers.authorization || "";
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (req.method === "POST" && req.url === "/v3/payments") {
      const input = JSON.parse(body);
      const id = `pay_${payments.size + 1}`;
      const payment = {
        id,
        status: "pending",
        paid: false,
        amount: input.amount,
        metadata: input.metadata,
        confirmation: { confirmation_url: `https://yookassa.ru/checkout/payments/${id}` },
      };
      payments.set(id, payment);
      send(200, payment);
      return;
    }

    const match = req.url.match(/^\/v3\/payments\/([a-zA-Z0-9_]+)$/);
    if (req.method === "GET" && match) {
      const payment = payments.get(match[1]);
      if (!payment) {
        send(404, { description: "not found" });
        return;
      }
      send(200, payment);
      return;
    }

    send(404, { description: "unknown route" });
  });
});

// ---------- Настройки приложения ----------
const DB_PATH = path.join(__dirname, "..", "data", "smoke.db");
for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(DB_PATH + suffix, { force: true });
}

process.env.DB_PATH = DB_PATH;
process.env.YOOKASSA_SHOP_ID = "test-shop";
process.env.YOOKASSA_SECRET_KEY = "test-secret";
process.env.YOOKASSA_API_URL = "http://127.0.0.1:3200/v3";
process.env.SITE_URL = "http://127.0.0.1:3100";

const { createServer } = require("../server.js");

const BASE = "http://127.0.0.1:3100";
let cookie = "";

function collectCookie(response) {
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  for (const item of cookies) {
    const pair = item.split(";")[0];
    if (pair.startsWith("nova_session=")) cookie = pair;
  }
}

async function api(pathname, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  collectCookie(response);
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function page(pathname) {
  const response = await fetch(BASE + pathname);
  return { status: response.status, text: await response.text() };
}

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

(async () => {
  await listen(mockYookassa, 3200);
  const app = createServer();
  await listen(app, 3100);

  try {
    const email = `test-${Date.now()}@example.com`;

    let result = await api("/api/health");
    assert.equal(result.status, 200);
    console.log("OK health");

    result = await api("/api/config");
    assert.equal(result.data.paymentsEnabled, true);
    assert.equal(result.data.paymentProvider, "yookassa");
    console.log("OK config: payments enabled");

    result = await api("/api/auth/register", {
      method: "POST",
      body: { name: "Тест", email, password: "password123" },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.user.subscription.planId, "start");
    console.log("OK register + session");

    result = await api("/api/auth/register", {
      method: "POST",
      body: { name: "Тест", email, password: "password123" },
    });
    assert.equal(result.status, 409);
    console.log("OK duplicate email rejected");

    result = await api("/api/me");
    assert.equal(result.status, 200);
    assert.equal(result.data.user.email, email);
    console.log("OK me");

    for (let i = 1; i <= 3; i += 1) {
      result = await api("/api/projects", {
        method: "POST",
        body: { name: `Проект ${i}`, description: "Тестовый проект" },
      });
      assert.equal(result.status, 201, JSON.stringify(result.data));
    }
    result = await api("/api/projects", { method: "POST", body: { name: "Четвёртый" } });
    assert.equal(result.status, 403);
    console.log("OK project limit on start plan");

    result = await api("/api/orders", { method: "POST", body: { planId: "pro" } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.match(result.data.paymentUrl, /^https:\/\/yookassa\.ru\//);
    assert.match(lastAuth, /^Basic /);
    const orderId = result.data.order.id;
    assert.equal(result.data.order.status, "pending");
    console.log("OK order created via YooKassa");

    result = await api("/api/orders");
    assert.equal(result.data.orders[0].status, "pending");
    assert.ok(result.data.orders[0].confirmationUrl);
    console.log("OK order history with payment link");

    // Оплата ещё не проведена — синхронизация не должна активировать тариф
    result = await api(`/api/orders/${orderId}/sync`, { method: "POST" });
    assert.equal(result.status, 200);
    assert.equal(result.data.order.status, "pending");
    result = await api("/api/me");
    assert.equal(result.data.user.subscription.planId, "start");
    console.log("OK unpaid order does not activate plan");

    // Эмулируем успешную оплату и вебхук ЮKassa
    const payment = payments.get("pay_1");
    payment.status = "succeeded";
    payment.paid = true;

    result = await api("/api/payments/yookassa", {
      method: "POST",
      body: { event: "payment.succeeded", object: { id: payment.id } },
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    console.log("OK webhook processed");

    result = await api("/api/me");
    assert.equal(result.data.user.subscription.planId, "pro");
    assert.equal(result.data.user.subscription.projectLimit, null);
    console.log("OK subscription activated by webhook");

    result = await api("/api/projects", { method: "POST", body: { name: "Проект 4" } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    console.log("OK unlimited projects on pro");

    result = await api("/api/orders");
    assert.equal(result.data.orders[0].status, "paid");
    assert.equal(result.data.orders[0].confirmationUrl, null);
    console.log("OK paid order in history");

    // Повторный вебхук не должен продлевать подписку дважды
    const before = (await api("/api/me")).data.user.subscription.expiresAt;
    result = await api("/api/payments/yookassa", {
      method: "POST",
      body: { event: "payment.succeeded", object: { id: payment.id } },
    });
    assert.equal(result.status, 200);
    const after = (await api("/api/me")).data.user.subscription.expiresAt;
    assert.equal(before, after);
    console.log("OK idempotent webhook");

    const firstProject = (await api("/api/projects")).data.projects[0];
    result = await api(`/api/projects/${firstProject.id}`, { method: "DELETE" });
    assert.equal(result.status, 200);
    console.log("OK project delete");

    result = await api("/api/auth/logout", { method: "POST" });
    assert.equal(result.status, 200);
    result = await api("/api/me");
    assert.equal(result.status, 401);
    console.log("OK logout");

    result = await api("/api/auth/login", { method: "POST", body: { email, password: "wrongpass" } });
    assert.equal(result.status, 401);
    result = await api("/api/auth/login", { method: "POST", body: { email, password: "password123" } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    console.log("OK login");

    for (const pathname of ["/", "/login.html", "/account.html", "/styles.css", "/api.js"]) {
      result = await page(pathname);
      assert.equal(result.status, 200, pathname);
    }
    for (const pathname of ["/server.js", "/package.json", "/data/smoke.db", "/checkout.html", "/.env"]) {
      result = await page(pathname);
      assert.equal(result.status, 404, pathname);
    }
    console.log("OK static + deny list");

    console.log("\nВсе проверки пройдены.");
  } finally {
    app.close();
    mockYookassa.close();
  }
})().catch((error) => {
  console.error("ТЕСТ УПАЛ:", error.message);
  process.exit(1);
});
