"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

const scrypt = promisify(crypto.scrypt);

// Подхватываем .env рядом с server.js (без сторонних зависимостей)
function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "nova.db");
const SITE_URL = (process.env.SITE_URL || `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`).replace(/\/+$/, "");
const SESSION_COOKIE = "nova_session";
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 дней
const MAX_BODY_SIZE = 100_000;

const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || "";
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || "";
const YOOKASSA_API_URL = (process.env.YOOKASSA_API_URL || "https://api.yookassa.ru/v3").replace(/\/+$/, "");
const PAYMENTS_ENABLED = Boolean(YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY);

const PLANS = {
  start: {
    id: "start",
    name: "Старт",
    price: 0,
    period: "навсегда",
    projectLimit: 3,
    features: ["3 проекта", "10 000 запросов", "Поддержка сообщества"],
  },
  pro: {
    id: "pro",
    name: "Про",
    price: 99000,
    period: "мес",
    projectLimit: null,
    features: ["Безлимит проектов", "1 млн запросов", "ИИ-функции", "Приоритетная поддержка"],
  },
  business: {
    id: "business",
    name: "Бизнес",
    price: 499000,
    period: "мес",
    projectLimit: null,
    features: ["Всё из «Про»", "Выделенный сервер", "SLA 99.99%", "Персональный менеджер"],
  },
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ---------- База данных ----------

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL DEFAULT 'start',
    expires_at INTEGER,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'RUB',
    status TEXT NOT NULL DEFAULT 'pending',
    provider TEXT NOT NULL,
    provider_payment_id TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
`);

// Миграция: сохраняем ссылку на оплату, чтобы можно было вернуться к заказу
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name);
if (!orderColumns.includes("confirmation_url")) {
  db.exec("ALTER TABLE orders ADD COLUMN confirmation_url TEXT");
}

db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());

function nowIso() {
  return new Date().toISOString();
}

// ---------- Утилиты ----------

function sendJson(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        reject(new HttpError(413, "Запрос слишком большой."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error();
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, "Не удалось прочитать данные запроса."));
      }
    });
    request.on("error", reject);
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function assertEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    throw new HttpError(400, "Введите корректный email.");
  }
}

function assertPassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    throw new HttpError(400, "Пароль должен содержать от 8 до 200 символов.");
  }
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL;
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    hashToken(token),
    userId,
    expiresAt,
    nowIso()
  );
  return { token, expiresAt };
}

function sessionCookie(token, maxAgeSeconds) {
  const secure = SITE_URL.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function currentUser(request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashToken(token));
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.token_hash);
    return null;
  }
  return db.prepare("SELECT id, email, name, created_at FROM users WHERE id = ?").get(session.user_id) || null;
}

function requireUser(request) {
  const user = currentUser(request);
  if (!user) throw new HttpError(401, "Нужно войти в аккаунт.");
  return user;
}

function effectiveSubscription(userId) {
  const row = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  if (!row) {
    const subscription = { user_id: userId, plan_id: "start", expires_at: null, updated_at: nowIso() };
    db.prepare(
      "INSERT INTO subscriptions (user_id, plan_id, expires_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(userId, subscription.plan_id, null, subscription.updated_at);
    return { planId: "start", expiresAt: null, plan: PLANS.start };
  }
  const expired = row.expires_at !== null && row.expires_at < Date.now();
  const planId = expired ? "start" : row.plan_id;
  return {
    planId,
    expiresAt: expired ? null : row.expires_at,
    plan: PLANS[planId] || PLANS.start,
  };
}

function publicUser(user) {
  const subscription = effectiveSubscription(user.id);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.created_at,
    subscription: {
      planId: subscription.planId,
      planName: subscription.plan.name,
      expiresAt: subscription.expiresAt,
      projectLimit: subscription.plan.projectLimit,
    },
  };
}

function planPayload(plan) {
  return {
    id: plan.id,
    name: plan.name,
    price: plan.price,
    period: plan.period,
    projectLimit: plan.projectLimit,
    features: plan.features,
  };
}

// ---------- Защита от подбора пароля ----------

const authAttempts = new Map();

function rateLimit(request, key, limit = 20, windowMs = 15 * 60 * 1000) {
  const ip = request.socket.remoteAddress || "unknown";
  const id = `${key}:${ip}`;
  const now = Date.now();
  const entry = authAttempts.get(id);
  if (!entry || entry.resetAt < now) {
    authAttempts.set(id, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
  if (entry.count > limit) {
    throw new HttpError(429, "Слишком много попыток. Попробуйте позже.");
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authAttempts) {
    if (entry.resetAt < now) authAttempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ---------- Проверка источника запроса ----------

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return; // запросы без Origin (curl, мобильные клиенты) не блокируем
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new HttpError(403, "Запрос отклонён: неверный источник.");
  }
  // Разрешаем тот же хост (localhost/127.0.0.1) и адрес из SITE_URL
  if (request.headers.host && originUrl.host === request.headers.host) return;
  try {
    if (originUrl.origin === new URL(SITE_URL).origin) return;
  } catch {
    return;
  }
  throw new HttpError(403, "Запрос отклонён: неверный источник.");
}

// ---------- ЮKassa ----------

function yookassaAuthHeader() {
  return `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64")}`;
}

async function yookassaRequest(method, url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: yookassaAuthHeader(),
        "Content-Type": "application/json",
        "Idempotence-Key": crypto.randomUUID(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!response.ok) {
      const detail = data?.description || data?.error || text.slice(0, 300);
      throw new HttpError(502, `ЮKassa: ${detail || `код ${response.status}`}`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new HttpError(504, "ЮKassa не ответила вовремя. Попробуйте ещё раз.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYookassaPayment(paymentId) {
  return yookassaRequest("GET", `${YOOKASSA_API_URL}/payments/${encodeURIComponent(paymentId)}`);
}

// ---------- Заказы и подписки ----------

function activateOrder(orderId, providerPaymentId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) throw new HttpError(404, "Заказ не найден.");
    if (order.status === "paid") {
      db.exec("COMMIT");
      return { alreadyPaid: true, order };
    }
    if (order.status !== "pending") throw new HttpError(409, "Заказ уже отменён.");

    db.prepare(
      "UPDATE orders SET status = 'paid', paid_at = ?, provider_payment_id = COALESCE(?, provider_payment_id) WHERE id = ?"
    ).run(nowIso(), providerPaymentId || null, orderId);

    const plan = PLANS[order.plan_id];
    if (!plan) throw new HttpError(400, "Неизвестный тариф.");

    const existing = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(order.user_id);
    const now = Date.now();
    let expiresAt = now + 30 * 24 * 60 * 60 * 1000;
    if (existing && existing.plan_id === plan.id && existing.expires_at && existing.expires_at > now) {
      expiresAt = existing.expires_at + 30 * 24 * 60 * 60 * 1000;
    }
    db.prepare(
      `INSERT INTO subscriptions (user_id, plan_id, expires_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET plan_id = excluded.plan_id,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`
    ).run(order.user_id, plan.id, expiresAt, nowIso());

    db.exec("COMMIT");
    return { alreadyPaid: false, order };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function orderPayload(order) {
  return {
    id: order.id,
    planId: order.plan_id,
    planName: PLANS[order.plan_id]?.name || order.plan_id,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    provider: order.provider,
    confirmationUrl: order.status === "pending" ? order.confirmation_url || null : null,
    createdAt: order.created_at,
    paidAt: order.paid_at,
  };
}

function getOrderForUser(orderId, userId) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(orderId, userId);
  if (!order) throw new HttpError(404, "Заказ не найден.");
  return order;
}

function assertPaymentMatchesOrder(payment, order) {
  const amount = Number(payment?.amount?.value);
  const currency = payment?.amount?.currency;
  const metadataUserId = payment?.metadata?.userId;
  if (
    !Number.isFinite(amount) ||
    Math.round(amount * 100) !== order.amount ||
    currency !== order.currency ||
    (metadataUserId && String(metadataUserId) !== String(order.user_id))
  ) {
    throw new HttpError(400, "Платёж не соответствует заказу.");
  }
}

// ---------- API ----------

async function handleApi(request, response, url) {
  const method = request.method;
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/api/config") {
    sendJson(response, 200, {
      paymentsEnabled: PAYMENTS_ENABLED,
      paymentProvider: "yookassa",
      siteUrl: SITE_URL,
      plans: Object.values(PLANS).map(planPayload),
    });
    return;
  }

  if (method === "POST" && pathname === "/api/auth/register") {
    assertSameOrigin(request);
    rateLimit(request, "register", 10);
    const input = await readJson(request);
    const name = String(input.name || "").trim();
    const email = normalizeEmail(input.email);
    const password = input.password;

    if (name.length < 2 || name.length > 60) {
      throw new HttpError(400, "Имя должно содержать от 2 до 60 символов.");
    }
    assertEmail(email);
    assertPassword(password);

    const passwordHash = await hashPassword(password);
    let userId;
    try {
      const result = db
        .prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)")
        .run(email, name, passwordHash, nowIso());
      userId = Number(result.lastInsertRowid);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw new HttpError(409, "Аккаунт с таким email уже существует.");
      }
      throw error;
    }
    db.prepare("INSERT INTO subscriptions (user_id, plan_id, expires_at, updated_at) VALUES (?, 'start', NULL, ?)").run(
      userId,
      nowIso()
    );
    const { token } = createSession(userId);
    const user = db.prepare("SELECT id, email, name, created_at FROM users WHERE id = ?").get(userId);
    sendJson(
      response,
      201,
      { user: publicUser(user) },
      { "Set-Cookie": sessionCookie(token, SESSION_TTL / 1000) }
    );
    return;
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    assertSameOrigin(request);
    rateLimit(request, "login", 20);
    const input = await readJson(request);
    const email = normalizeEmail(input.email);
    const password = input.password;
    if (!email || typeof password !== "string") {
      throw new HttpError(400, "Введите email и пароль.");
    }
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    const valid = user ? await verifyPassword(password, user.password_hash) : false;
    if (!valid) throw new HttpError(401, "Неверный email или пароль.");

    const { token } = createSession(user.id);
    sendJson(
      response,
      200,
      { user: publicUser(user) },
      { "Set-Cookie": sessionCookie(token, SESSION_TTL / 1000) }
    );
    return;
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    assertSameOrigin(request);
    const token = parseCookies(request)[SESSION_COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    sendJson(response, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
    return;
  }

  if (method === "GET" && pathname === "/api/me") {
    const user = currentUser(request);
    if (!user) {
      sendJson(response, 401, { error: "Нужно войти в аккаунт." });
      return;
    }
    sendJson(response, 200, { user: publicUser(user) });
    return;
  }

  if (method === "GET" && pathname === "/api/plans") {
    sendJson(response, 200, {
      paymentsEnabled: PAYMENTS_ENABLED,
      plans: Object.values(PLANS).map(planPayload),
    });
    return;
  }

  if (method === "GET" && pathname === "/api/projects") {
    const user = requireUser(request);
    const projects = db
      .prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC")
      .all(user.id)
      .map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        createdAt: project.created_at,
      }));
    sendJson(response, 200, { projects });
    return;
  }

  if (method === "POST" && pathname === "/api/projects") {
    assertSameOrigin(request);
    const user = requireUser(request);
    const input = await readJson(request);
    const name = String(input.name || "").trim();
    const description = String(input.description || "").trim();
    if (name.length < 2 || name.length > 80) {
      throw new HttpError(400, "Название проекта должно содержать от 2 до 80 символов.");
    }
    if (description.length > 500) {
      throw new HttpError(400, "Описание не должно превышать 500 символов.");
    }

    const subscription = effectiveSubscription(user.id);
    const limit = subscription.plan.projectLimit;
    if (limit !== null) {
      const count = db.prepare("SELECT COUNT(*) AS count FROM projects WHERE user_id = ?").get(user.id).count;
      if (count >= limit) {
        throw new HttpError(
          403,
          `На тарифе «${subscription.plan.name}» доступно не больше ${limit} проектов. Оформите «Про», чтобы снять лимит.`
        );
      }
    }

    const project = {
      id: `prj_${crypto.randomBytes(8).toString("hex")}`,
      name,
      description,
      createdAt: nowIso(),
    };
    db.prepare("INSERT INTO projects (id, user_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)").run(
      project.id,
      user.id,
      project.name,
      project.description,
      project.createdAt
    );
    sendJson(response, 201, { project });
    return;
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_]+)$/);
  if (method === "DELETE" && projectMatch) {
    assertSameOrigin(request);
    const user = requireUser(request);
    const result = db
      .prepare("DELETE FROM projects WHERE id = ? AND user_id = ?")
      .run(projectMatch[1], user.id);
    if (!result.changes) throw new HttpError(404, "Проект не найден.");
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/api/orders") {
    const user = requireUser(request);
    const orders = db
      .prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
      .all(user.id)
      .map(orderPayload);
    sendJson(response, 200, { orders });
    return;
  }

  if (method === "POST" && pathname === "/api/orders") {
    assertSameOrigin(request);
    const user = requireUser(request);
    const input = await readJson(request);
    const plan = PLANS[input.planId];
    if (!plan || plan.price <= 0) {
      throw new HttpError(400, "Выберите платный тариф.");
    }
    if (!PAYMENTS_ENABLED) {
      throw new HttpError(
        503,
        "Онлайн-оплата не настроена. Укажите YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY в файле .env и перезапустите сервер."
      );
    }

    const orderId = `ord_${crypto.randomBytes(8).toString("hex")}`;
    const payment = await yookassaRequest("POST", `${YOOKASSA_API_URL}/payments`, {
      amount: { value: (plan.price / 100).toFixed(2), currency: "RUB" },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: `${SITE_URL}/account.html?order=${orderId}`,
      },
      description: `Nova — тариф «${plan.name}» на 30 дней`,
      metadata: { orderId, userId: String(user.id) },
    });

    const confirmationUrl = payment?.confirmation?.confirmation_url;
    if (!payment?.id || !confirmationUrl) {
      throw new HttpError(502, "ЮKassa не вернула ссылку на оплату. Попробуйте ещё раз.");
    }

    db.prepare(
      `INSERT INTO orders (id, user_id, plan_id, amount, currency, status, provider, provider_payment_id, confirmation_url, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 'yookassa', ?, ?, ?)`
    ).run(orderId, user.id, plan.id, plan.price, "RUB", payment.id, confirmationUrl, nowIso());

    sendJson(response, 201, {
      order: orderPayload(db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId)),
      paymentUrl: confirmationUrl,
    });
    return;
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([a-zA-Z0-9_]+)(\/[a-z-]+)?$/);
  if (orderMatch) {
    const orderId = orderMatch[1];
    const action = orderMatch[2];

    if (method === "GET" && !action) {
      const user = requireUser(request);
      const order = getOrderForUser(orderId, user.id);
      sendJson(response, 200, { order: orderPayload(order) });
      return;
    }

    if (method === "POST" && action === "/sync") {
      assertSameOrigin(request);
      const user = requireUser(request);
      const order = getOrderForUser(orderId, user.id);
      if (order.status === "paid") {
        sendJson(response, 200, { order: orderPayload(order) });
        return;
      }
      if (!PAYMENTS_ENABLED || !order.provider_payment_id) {
        throw new HttpError(400, "Этот заказ нельзя синхронизировать.");
      }
      const payment = await fetchYookassaPayment(order.provider_payment_id);
      if (payment.status === "succeeded" && payment.paid) {
        assertPaymentMatchesOrder(payment, order);
        activateOrder(order.id, payment.id);
      } else if (payment.status === "canceled") {
        db.prepare("UPDATE orders SET status = 'canceled' WHERE id = ?").run(order.id);
      }
      sendJson(response, 200, {
        order: orderPayload(db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id)),
      });
      return;
    }
  }

  if (method === "POST" && pathname === "/api/payments/yookassa") {
    if (!PAYMENTS_ENABLED) throw new HttpError(404, "Оплата через ЮKassa не настроена.");
    const notification = await readJson(request);
    const paymentId = notification?.object?.id;
    if (!paymentId) throw new HttpError(400, "Некорректное уведомление.");
    // Проверяем платёж напрямую в API, а не доверяем телу запроса
    const payment = await fetchYookassaPayment(paymentId);
    const orderId = payment?.metadata?.orderId;
    if (!orderId) throw new HttpError(400, "В платеже нет заказа.");
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!order) throw new HttpError(404, "Заказ не найден.");
    if (payment.status === "succeeded" && payment.paid) {
      assertPaymentMatchesOrder(payment, order);
      activateOrder(orderId, payment.id);
    } else if (payment.status === "canceled") {
      db.prepare("UPDATE orders SET status = 'canceled' WHERE id = ? AND status = 'pending'").run(orderId);
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "Не найдено." });
}

// ---------- Статика ----------

const DENY_FILES = new Set(["server.js", "package.json", "package-lock.json", ".env"]);
const DENY_DIRS = new Set(["data", "node_modules", ".git"]);

function serveStatic(request, response, url) {
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const segments = requested.split(/[\\/]+/);
  if (
    !requested ||
    segments.some((segment) => segment.startsWith(".") || DENY_DIRS.has(segment)) ||
    DENY_FILES.has(segments[segments.length - 1])
  ) {
    response.writeHead(404).end("Not found");
    return;
  }

  const filePath = path.resolve(ROOT_DIR, requested);
  if (!filePath.startsWith(`${ROOT_DIR}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  if (!MIME_TYPES[extension]) {
    response.writeHead(404).end("Not found");
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension],
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=300",
    });
    response.end(contents);
  });
}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        serveStatic(request, response, url);
        return;
      }
      response.writeHead(405, { Allow: "GET, POST, DELETE" }).end("Method not allowed");
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      sendJson(response, status, {
        error: status === 500 ? "Внутренняя ошибка сервера." : error.message,
      });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Nova запущена: ${SITE_URL}`);
    if (PAYMENTS_ENABLED) {
      console.log(`Оплата: ЮKassa (${YOOKASSA_API_URL}).`);
      if (!SITE_URL.startsWith("https://") && !SITE_URL.startsWith("http://127.0.0.1")) {
        console.warn("Внимание: для приёма платежей укажите публичный адрес сайта в SITE_URL.");
      }
    } else {
      console.warn(
        "Оплата не настроена: заполните YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY в .env. Покупка тарифов недоступна."
      );
    }
  });
}

module.exports = { createServer };
