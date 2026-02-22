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
  min: 1,             // always keep one warm connection — avoids cold-start burst failures
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,  // fail fast: 8s × 2 attempts = 16s max, not 60s
  // TCP keepalive — prevents NAT/firewall from silently dropping idle connections
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err) => {
  console.error("[pool] idle client error:", err.message);
});

pool.on("connect", () => {
  console.log("[pool] new connection established");
});

pool.on("remove", () => {
  console.log("[pool] connection removed from pool");
});

// Auto-retry once on stale PgBouncer connections (Connection terminated / ECONNRESET).
// Does NOT retry "timeout exceeded" — that means the pooler is down; retrying wastes another 8s.
// Transparent to all controllers — no changes needed anywhere else.
const _query = pool.query.bind(pool);
pool.query = async function (...args) {
  try {
    return await _query(...args);
  } catch (err) {
    if (
      (err.message.includes("Connection terminated") || err.code === "ECONNRESET") &&
      !err.message.includes("timeout exceeded")
    ) {
      console.warn("[pool] stale connection — retrying once:", err.message);
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

module.exports = pool;