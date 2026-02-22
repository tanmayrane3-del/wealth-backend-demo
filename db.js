const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.SUPABASE_URI,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  // Required for Supabase Transaction Pooler (PgBouncer)
  // PgBouncer doesn't support named prepared statements
  statement_cache_size: 0,
});

// Prevent unhandled errors from crashing the process when
// Supabase closes a connection that's sitting idle in the pool
pool.on("error", (err) => {
  console.error("[pool] idle client error:", err.message);
});

module.exports = pool;