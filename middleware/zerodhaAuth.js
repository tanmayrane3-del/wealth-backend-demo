const pool = require("../db");

/**
 * Returns { access_token, api_key } for the user if valid.
 * Throws an error if no credentials exist or token has expired (after 6AM IST daily).
 */
async function getValidAccessToken(user_id) {
  const result = await pool.query(
    `SELECT api_key, access_token, access_token_generated_at
     FROM zerodha_credentials
     WHERE user_id = $1 AND is_active = true`,
    [user_id]
  );

  if (result.rows.length === 0) {
    throw new Error("Zerodha credentials not found. Please save your API key and secret first.");
  }

  const { api_key, access_token, access_token_generated_at } = result.rows[0];

  if (!access_token || !access_token_generated_at) {
    throw new Error("Zerodha not authenticated. Please complete the login flow.");
  }

  // Kite access tokens expire at 6:00 AM IST daily.
  // IST = UTC+5:30, so 6AM IST = 00:30 UTC.
  const now = new Date();
  const today6amIST = new Date();
  today6amIST.setUTCHours(0, 30, 0, 0); // 00:30 UTC = 06:00 IST

  // If current UTC time is before 00:30 UTC, today's 6AM IST hasn't arrived yet —
  // use yesterday's 6AM IST as the expiry boundary.
  if (now.getTime() < today6amIST.getTime()) {
    today6amIST.setUTCDate(today6amIST.getUTCDate() - 1);
  }

  const tokenGeneratedAt = new Date(access_token_generated_at);
  if (tokenGeneratedAt.getTime() < today6amIST.getTime()) {
    throw new Error("Zerodha session expired. Please re-authenticate via the login flow.");
  }

  return { access_token, api_key };
}

module.exports = { getValidAccessToken };
