const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DB_PATH = path.join(__dirname, "..", "data", "nokeys.db");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });

process.env.DB_PATH = DB_PATH;
delete process.env.YOOKASSA_SHOP_ID;
delete process.env.YOOKASSA_SECRET_KEY;

const { createServer } = require("../server.js");
const BASE = "http://127.0.0.1:3300";

(async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(3300, "127.0.0.1", resolve));

  const config = await (await fetch(`${BASE}/api/config`)).json();
  assert.equal(config.paymentsEnabled, false);
  console.log("OK config: payments disabled without keys");

  const register = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Без ключей", email: "nokeys@example.com", password: "password123" }),
  });
  assert.equal(register.status, 201);
  const cookie = register.headers.getSetCookie()[0].split(";")[0];

  const order = await fetch(`${BASE}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ planId: "pro" }),
  });
  const data = await order.json();
  assert.equal(order.status, 503);
  assert.match(data.error, /YOOKASSA_SHOP_ID/);
  console.log("OK purchase blocked with clear message");

  const projects = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: "Проект без оплаты" }),
  });
  assert.equal(projects.status, 201);
  console.log("OK projects work without payments");

  server.close();
  console.log("\nВсе проверки без ключей пройдены.");
  process.exit(0);
})().catch((error) => {
  console.error("ТЕСТ УПАЛ:", error.message);
  process.exit(1);
});
