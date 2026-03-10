const cron = require("node-cron");
const pool = require("../db");

const KITE_API_BASE = process.env.KITE_API_BASE_URL || "https://api.kite.trade";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the current time falls within NSE market hours:
 * Monday–Friday, 9:15 AM – 3:30 PM IST (UTC+5:30).
 */
function isMarketOpen() {
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const day = istNow.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;
  const totalMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  return totalMinutes >= 555 && totalMinutes <= 930; // 9:15 to 15:30
}

/**
 * Returns true if the Kite access_token was generated before today's 6:00 AM IST.
 * Mirrors the logic in middleware/zerodhaAuth.js — inlined here because the cron
 * context has no req/res to pass into the middleware.
 */
function isTokenExpired(access_token_generated_at) {
  const now = new Date();
  const cutoff = new Date();
  cutoff.setUTCHours(0, 30, 0, 0); // 6:00 AM IST = 00:30 UTC
  if (now < cutoff) {
    cutoff.setUTCDate(cutoff.getUTCDate() - 1); // haven't hit today's 6AM yet — use yesterday's
  }
  return new Date(access_token_generated_at) < cutoff;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

/**
 * Fetches live holdings and positions from Kite for one user and upserts
 * them into stock_holdings. Throws "TOKEN_EXCEPTION" if Kite rejects the token.
 */
async function syncUserHoldings(user_id, api_key, access_token) {
  const headers = {
    "X-Kite-Version": "3",
    Authorization: `token ${api_key}:${access_token}`
  };

  // ── Holdings ──────────────────────────────────────────────────────────────
  const holdingsRes = await fetch(`${KITE_API_BASE}/portfolio/holdings`, { headers });
  const holdingsBody = await holdingsRes.json();

  if (holdingsBody.error_type === "TokenException") {
    throw new Error("TOKEN_EXCEPTION");
  }
  if (!holdingsRes.ok || holdingsBody.status !== "success") {
    throw new Error(`Kite holdings error: ${holdingsBody.message || holdingsRes.status}`);
  }

  const holdings = holdingsBody.data ?? [];

  // ── Upsert helper ─────────────────────────────────────────────────────────
  const upsertHolding = async (h) => {
    const quantity = h.quantity ?? 0;
    const average_price = h.average_price ?? 0;
    const last_price = h.last_price ?? 0;
    const current_value = last_price * quantity;
    const pnl = (last_price - average_price) * quantity;
    const pnl_percentage = average_price !== 0
      ? ((last_price - average_price) / average_price) * 100
      : 0;

    await pool.query(
      `INSERT INTO stock_holdings (
        user_id, tradingsymbol, exchange, isin,
        quantity, t1_quantity, average_price, last_price, close_price,
        current_value, pnl, pnl_percentage, day_change, day_change_percentage,
        product, authorised_quantity, collateral_quantity, collateral_type,
        last_synced_at, updated_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14,
        $15, $16, $17, $18,
        NOW(), NOW()
      )
      ON CONFLICT (user_id, tradingsymbol, exchange)
      DO UPDATE SET
        isin                  = EXCLUDED.isin,
        quantity              = EXCLUDED.quantity,
        t1_quantity           = EXCLUDED.t1_quantity,
        average_price         = EXCLUDED.average_price,
        last_price            = EXCLUDED.last_price,
        close_price           = EXCLUDED.close_price,
        current_value         = EXCLUDED.current_value,
        pnl                   = EXCLUDED.pnl,
        pnl_percentage        = EXCLUDED.pnl_percentage,
        day_change            = EXCLUDED.day_change,
        day_change_percentage = EXCLUDED.day_change_percentage,
        product               = EXCLUDED.product,
        authorised_quantity   = EXCLUDED.authorised_quantity,
        collateral_quantity   = EXCLUDED.collateral_quantity,
        collateral_type       = EXCLUDED.collateral_type,
        last_synced_at        = NOW(),
        updated_at            = NOW()`,
      [
        user_id,
        h.tradingsymbol,
        h.exchange,
        h.isin ?? null,
        quantity,
        h.t1_quantity ?? 0,
        average_price,
        last_price,
        h.close_price ?? 0,
        current_value,
        pnl,
        pnl_percentage,
        h.day_change ?? 0,
        h.day_change_percentage ?? 0,
        h.product ?? "CNC",
        h.authorised_quantity ?? 0,
        h.collateral_quantity ?? 0,
        h.collateral_type ?? null
      ]
    );
  };

  for (const h of holdings) await upsertHolding(h);

  // Delete rows that are no longer in Kite holdings (sold stocks, stale data)
  if (holdings.length > 0) {
    const symbols = holdings.map(h => h.tradingsymbol);
    await pool.query(
      `DELETE FROM stock_holdings
       WHERE user_id = $1
         AND tradingsymbol != ALL($2::text[])`,
      [user_id, symbols]
    );
  }

  return { holdingsSynced: holdings.length };
}

// ---------------------------------------------------------------------------
// Sync runner
// ---------------------------------------------------------------------------

/**
 * Fetches all active Zerodha users and syncs their holdings.
 * Safe to call directly (e.g., from /admin/sync-now) — does NOT check isMarketOpen().
 */
async function runMarketSync() {
  console.log("[MarketSync] Starting sync run...");

  let users;
  try {
    const result = await pool.query(
      `SELECT user_id, api_key, access_token, access_token_generated_at
       FROM zerodha_credentials
       WHERE is_active = true AND access_token IS NOT NULL`
    );
    users = result.rows;
  } catch (err) {
    console.error("[MarketSync] Failed to fetch users:", err.message);
    return false;
  }

  console.log(`[MarketSync] ${users.length} user(s) to sync`);
  let processed = 0;

  for (const user of users) {
    // Expired token — mark for re-auth, skip sync
    if (isTokenExpired(user.access_token_generated_at)) {
      try {
        await pool.query(
          `UPDATE zerodha_credentials SET needs_reauth = true WHERE user_id = $1`,
          [user.user_id]
        );
      } catch (dbErr) {
        console.error(`[MarketSync] Failed to mark needs_reauth for ${user.user_id}:`, dbErr.message);
      }
      console.log(`[MarketSync] Skipped ${user.user_id} — token expired, marked needs_reauth`);
      await sleep(500);
      continue;
    }

    try {
      const { holdingsSynced, positionsSynced } = await syncUserHoldings(
        user.user_id,
        user.api_key,
        user.access_token
      );
      console.log(
        `[MarketSync] Synced ${user.user_id} — ${holdingsSynced} holdings, ${positionsSynced} positions`
      );
      processed++;
    } catch (err) {
      if (err.message === "TOKEN_EXCEPTION") {
        try {
          await pool.query(
            `UPDATE zerodha_credentials SET needs_reauth = true WHERE user_id = $1`,
            [user.user_id]
          );
        } catch (dbErr) {
          console.error(`[MarketSync] Failed to mark needs_reauth for ${user.user_id}:`, dbErr.message);
        }
        console.error(`[MarketSync] TokenException for ${user.user_id} — marked needs_reauth`);
      } else {
        console.error(`[MarketSync] Sync failed for ${user.user_id}:`, err.message);
      }
    }

    await sleep(500);
  }

  console.log(`[MarketSync] Sync run complete. ${processed}/${users.length} users synced.`);
  return true;
}

// ---------------------------------------------------------------------------
// Cron initializer
// ---------------------------------------------------------------------------

/**
 * Registers two cron jobs:
 *   1. Every 5 min during market hours (9:15–15:30 IST, Mon–Fri)
 *   2. Final sync at 15:35 IST (10:05 UTC) Mon–Fri to capture closing prices
 * Call this once from index.js after app.listen().
 */
function initMarketSync() {
  // Every 5 minutes — isMarketOpen() gates actual execution
  cron.schedule("*/5 * * * *", async () => {
    if (!isMarketOpen()) return;
    await runMarketSync();
  });

  // Final sync: 15:35 IST = 10:05 UTC, Monday–Friday
  // If the DB is unreachable, retries every 5 minutes until it succeeds.
  cron.schedule("5 10 * * 1-5", async () => {
    const succeeded = await runMarketSync();
    if (!succeeded) {
      console.log("[MarketSync] Final sync failed — retrying every 5min until success");
      const retryInterval = setInterval(async () => {
        const retryOk = await runMarketSync();
        if (retryOk) {
          console.log("[MarketSync] Final sync retry succeeded — stopping retries");
          clearInterval(retryInterval);
        }
      }, 5 * 60 * 1000);
    }
  });

  console.log("[MarketSync] Cron jobs initialized — every 5min (market hours) + final at 15:35 IST");
}

module.exports = { initMarketSync, runMarketSync };
