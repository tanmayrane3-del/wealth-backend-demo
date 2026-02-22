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
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 30000,
});

// Prevent unhandled errors from crashing the process when
// Supabase closes a connection that's sitting idle in the pool
pool.on("error", (err) => {
  console.error("[pool] idle client error:", err.message);
});

module.exports = pool;