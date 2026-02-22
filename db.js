const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.SUPABASE_URI,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,       // Release idle connections after 10s (before Supabase kills them)
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Prevent unhandled errors from crashing the process when
// Supabase closes a connection that's sitting idle in the pool
pool.on("error", (err) => {
  console.error("[pool] idle client error:", err.message);
});

module.exports = pool;