const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.SUPABASE_URI,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

module.exports = pool;