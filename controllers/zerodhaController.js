const crypto = require("crypto");
const pool = require("../db");
const { encrypt, decrypt } = require("../utils/encryption");
const { success, fail } = require("../utils/respond");

const KITE_API_BASE = process.env.KITE_API_BASE_URL || "https://api.kite.trade";

/**
 * POST /api/zerodha/credentials
 * Body: { api_key, api_secret }
 * Saves (or updates) the user's Zerodha API credentials.
 * api_secret is AES-256 encrypted before storage.
 */
const saveCredentials = async (req, res) => {
  const user_id = req.user_id;
  const { api_key, api_secret } = req.body;

  if (!api_key || !api_secret) {
    return fail(res, "api_key and api_secret are required", 400);
  }

  const encryptedSecret = encrypt(api_secret);

  try {
    await pool.query(
      `INSERT INTO zerodha_credentials (user_id, api_key, api_secret, is_active, updated_at)
       VALUES ($1, $2, $3, true, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET
         api_key    = EXCLUDED.api_key,
         api_secret = EXCLUDED.api_secret,
         is_active  = true,
         updated_at = NOW()`,
      [user_id, api_key, encryptedSecret]
    );

    return success(res, { message: "Credentials saved successfully" }, 201);
  } catch (err) {
    console.error("[Zerodha] Save credentials error:", err.message);
    return fail(res, "Failed to save credentials: " + err.message, 500);
  }
};

/**
 * GET /api/zerodha/credentials
 * Returns the user's stored Zerodha API key and decrypted API secret.
 */
const getCredentials = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT api_key, api_secret FROM zerodha_credentials WHERE user_id = $1 AND is_active = true`,
      [user_id]
    );

    if (result.rows.length === 0) {
      return fail(res, "Zerodha credentials not found.", 404);
    }

    const { api_key, api_secret: encryptedSecret } = result.rows[0];
    const api_secret = decrypt(encryptedSecret);

    return success(res, { api_key, api_secret });
  } catch (err) {
    console.error("[Zerodha] Get credentials error:", err.message);
    return fail(res, "Failed to fetch credentials: " + err.message, 500);
  }
};

/**
 * GET /api/zerodha/auth-url
 * Returns the Zerodha login URL for the authenticated user.
 */
const getAuthUrl = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT api_key FROM zerodha_credentials WHERE user_id = $1 AND is_active = true`,
      [user_id]
    );

    if (result.rows.length === 0) {
      return fail(res, "Zerodha credentials not found. Please save your API key first.", 404);
    }

    const { api_key } = result.rows[0];

    // Pass session token as state — Zerodha echoes it back in the redirect,
    // so the callback can identify the user without a session header.
    const session_token = req.headers["x-session-token"] || req.body?.session_token;
    const auth_url = `https://kite.zerodha.com/connect/login?v=3&api_key=${api_key}&state=${session_token}`;

    return success(res, { auth_url });
  } catch (err) {
    console.error("[Zerodha] Get auth URL error:", err.message);
    return fail(res, "Failed to generate auth URL: " + err.message, 500);
  }
};

/**
 * POST /api/zerodha/callback
 * Body: { request_token }
 * Exchanges request_token for access_token via Kite API and saves to DB.
 */
const handleCallback = async (req, res) => {
  const user_id = req.user_id;
  const { request_token } = req.body;

  if (!request_token) {
    return fail(res, "request_token is required", 400);
  }

  try {
    const result = await pool.query(
      `SELECT api_key, api_secret FROM zerodha_credentials WHERE user_id = $1 AND is_active = true`,
      [user_id]
    );

    if (result.rows.length === 0) {
      return fail(res, "Zerodha credentials not found. Please save your API key first.", 404);
    }

    const { api_key, api_secret: encryptedSecret } = result.rows[0];
    const api_secret = decrypt(encryptedSecret);

    // SHA-256 checksum: sha256(api_key + request_token + api_secret)
    const checksum = crypto
      .createHash("sha256")
      .update(api_key + request_token + api_secret)
      .digest("hex");

    // Exchange request_token for access_token
    const kiteRes = await fetch(`${KITE_API_BASE}/session/token`, {
      method: "POST",
      headers: {
        "X-Kite-Version": "3",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ api_key, request_token, checksum })
    });

    const kiteBody = await kiteRes.json();

    if (!kiteRes.ok || kiteBody.status !== "success") {
      console.error("[Zerodha] Token exchange failed:", kiteBody);
      return fail(res, kiteBody.message || "Token exchange with Zerodha failed", 502);
    }

    const {
      access_token,
      user_id: zerodha_user_id,
      user_name: zerodha_user_name
    } = kiteBody.data;

    await pool.query(
      `UPDATE zerodha_credentials
       SET access_token               = $1,
           request_token              = $2,
           access_token_generated_at  = NOW(),
           zerodha_user_id            = $3,
           zerodha_user_name          = $4,
           updated_at                 = NOW()
       WHERE user_id = $5`,
      [access_token, request_token, zerodha_user_id, zerodha_user_name, user_id]
    );

    return success(res, {
      message: "Authenticated successfully",
      zerodha_user_id,
      zerodha_user_name
    });
  } catch (err) {
    console.error("[Zerodha] Callback error:", err.message);
    return fail(res, "Authentication failed: " + err.message, 500);
  }
};

/**
 * GET /api/kite/auth/callback
 * Zerodha redirects here after user login.
 * Query params: request_token, status, state (= session token passed in auth URL)
 * No session middleware — user is identified via the state param.
 */
const handleKiteCallback = async (req, res) => {
  const { request_token, status, state: session_token } = req.query;

  if (status !== "success" || !request_token) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>Zerodha Login Failed</h2>
        <p>Status: ${status || "unknown"}. Please try again from the app.</p>
      </body></html>
    `);
  }

  if (!session_token) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>Invalid Callback</h2>
        <p>Missing state parameter. Please try again from the app.</p>
      </body></html>
    `);
  }

  try {
    // Resolve user_id from session token
    const sessionResult = await pool.query(
      `SELECT user_id FROM user_sessions
       WHERE session_token = $1 AND is_active = true AND expires_at > NOW()`,
      [session_token]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
          <h2>Session Expired</h2>
          <p>Your app session has expired. Please log in to the app and try again.</p>
        </body></html>
      `);
    }

    const user_id = sessionResult.rows[0].user_id;

    const credResult = await pool.query(
      `SELECT api_key, api_secret FROM zerodha_credentials WHERE user_id = $1 AND is_active = true`,
      [user_id]
    );

    if (credResult.rows.length === 0) {
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
          <h2>Credentials Not Found</h2>
          <p>Please save your Zerodha API key in the app first.</p>
        </body></html>
      `);
    }

    const { api_key, api_secret: encryptedSecret } = credResult.rows[0];
    const api_secret = decrypt(encryptedSecret);

    // SHA-256 checksum: sha256(api_key + request_token + api_secret)
    const checksum = crypto
      .createHash("sha256")
      .update(api_key + request_token + api_secret)
      .digest("hex");

    // Exchange request_token for access_token
    const kiteRes = await fetch(`${KITE_API_BASE}/session/token`, {
      method: "POST",
      headers: {
        "X-Kite-Version": "3",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ api_key, request_token, checksum })
    });

    const kiteBody = await kiteRes.json();

    if (!kiteRes.ok || kiteBody.status !== "success") {
      console.error("[Zerodha] Token exchange failed:", kiteBody);
      return res.status(502).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
          <h2>Authentication Failed</h2>
          <p>${kiteBody.message || "Token exchange with Zerodha failed"}. Please try again.</p>
        </body></html>
      `);
    }

    const {
      access_token,
      user_id: zerodha_user_id,
      user_name: zerodha_user_name
    } = kiteBody.data;

    await pool.query(
      `UPDATE zerodha_credentials
       SET access_token              = $1,
           request_token             = $2,
           access_token_generated_at = NOW(),
           zerodha_user_id           = $3,
           zerodha_user_name         = $4,
           updated_at                = NOW()
       WHERE user_id = $5`,
      [access_token, request_token, zerodha_user_id, zerodha_user_name, user_id]
    );

    console.log(`[Zerodha] Auth successful for user ${user_id} (${zerodha_user_name})`);

    // Redirect to custom app scheme — Chrome Custom Tab intercepts this,
    // closes itself, and brings StocksActivity to the foreground via onNewIntent.
    return res.redirect(`wealthapp://auth/success?user=${encodeURIComponent(zerodha_user_name)}`);
  } catch (err) {
    console.error("[Zerodha] Kite callback error:", err.message);
    return res.status(500).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>Server Error</h2>
        <p>Something went wrong. Please try again.</p>
      </body></html>
    `);
  }
};

module.exports = { saveCredentials, getCredentials, getAuthUrl, handleCallback, handleKiteCallback };
