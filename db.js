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
  max: 3,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 30000,
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

// Startup probe — logs exactly what succeeds or fails
console.log(`[DB] Config: host=${process.env.DB_HOST} port=${process.env.DB_PORT} user=${process.env.DB_USER} db=${process.env.DB_NAME}`);
pool.query("SELECT 1 AS ok")
  .then(() => console.log("[DB] Startup connection test: OK"))
  .catch((err) => {
    console.error("[DB] Startup connection test FAILED:", err.message);
    if (err.cause) console.error("[DB] Caused by:", err.cause.message);
  });

module.exports = pool;