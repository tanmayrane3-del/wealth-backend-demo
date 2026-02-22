const { Pool } = require("pg");
require("dotenv").config();

// Use individual params so special chars in password don't break URL parsing
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "6543"),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "postgres",
  ssl: { rejectUnauthorized: false },
  min: 1,
  max: 10,
  idleTimeoutMillis: 60000,      // clean up extra (non-min) connections after 60s idle
  connectionTimeoutMillis: 8000, // fail fast: 8s × 2 attempts = 16s max
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err) => {
  console.error("[pool] idle client error:", err.message);
});

const connectionTimes = new Map();

pool.on("connect", (client) => {
  connectionTimes.set(client, Date.now());
  console.log("[pool] new connection established");
});

pool.on("remove", (client) => {
  const born = connectionTimes.get(client);
  const lived = born ? Math.round((Date.now() - born) / 1000) : "?";
  connectionTimes.delete(client);
  console.log(`[pool] connection removed — lived ${lived}s`);
});

// Auto-retry once on stale connections (Connection terminated / ECONNRESET).
// 2s delay before retry — gives PgBouncer time to accept a new connection.
// Does NOT retry "timeout exceeded" — pooler is down, retrying wastes another 8s.
// Transparent to all controllers — no changes needed anywhere else.
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const _query = pool.query.bind(pool);
pool.query = async function (...args) {
  try {
    return await _query(...args);
  } catch (err) {
    if (
      (err.message.includes("Connection terminated") || err.code === "ECONNRESET") &&
      !err.message.includes("timeout exceeded")
    ) {
      console.warn("[pool] stale connection — retrying in 2s:", err.message);
      await sleep(2000);
      return await _query(...args);
    }
    throw err;
  }
};

// Startup probe — logs exactly what succeeds or fails
console.log(`[DB] Config: host=${process.env.DB_HOST} port=${process.env.DB_PORT} user=${process.env.DB_USER} db=${process.env.DB_NAME}`);
pool.query("SELECT 1 AS ok")
  .then(() => console.log("[DB] Startup connection test: OK"))
  .catch((err) => {
    console.error("[DB] Startup connection test FAILED:", err.message);
    if (err.cause) console.error("[DB] Caused by:", err.cause.message);
  });

// SQL keep-alive ping every 30s — prevents Render's NAT router from dropping
// idle DB connections. TCP keepalive alone is insufficient on Render's network.
// Also acts as a proactive health check — stale connections get retried and
// replaced before any real user request hits them.
setInterval(() => {
  pool.query("SELECT 1").catch((err) => {
    console.warn("[pool] keep-alive ping failed:", err.message);
  });
}, 30 * 1000);

module.exports = pool;
