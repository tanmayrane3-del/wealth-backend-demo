const pool = require("../db");
const { getValidAccessToken } = require("../middleware/zerodhaAuth");
const { success, fail } = require("../utils/respond");
const { recomputeStocksCagr } = require("../services/cagrCalculator");

const KITE_API_BASE = process.env.KITE_API_BASE_URL || "https://api.kite.trade";

/**
 * GET /api/holdings/sync
 * Fetches live holdings from Kite and upserts into stock_holdings table.
 */
const syncHoldings = async (req, res) => {
  const user_id = req.user_id;

  let access_token, api_key;
  try {
    ({ access_token, api_key } = await getValidAccessToken(user_id));
  } catch (err) {
    return fail(res, err.message, 401);
  }

  try {
    const kiteRes = await fetch(`${KITE_API_BASE}/portfolio/holdings`, {
      headers: {
        "X-Kite-Version": "3",
        "Authorization": `token ${api_key}:${access_token}`
      }
    });

    const kiteBody = await kiteRes.json();

    if (!kiteRes.ok || kiteBody.status !== "success") {
      console.error("[Holdings] Kite API error:", kiteBody);
      return fail(res, kiteBody.message || "Failed to fetch holdings from Zerodha", 502);
    }

    const holdings = kiteBody.data;

    if (!holdings || holdings.length === 0) {
      return success(res, { synced: 0, holdings: [] });
    }

    // Upsert each holding
    for (const h of holdings) {
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
          h.collateral_type || null
        ]
      );
    }

    // Delete rows whose (tradingsymbol, exchange) pair is no longer in Kite holdings
    if (holdings.length > 0) {
      const symbols   = holdings.map(h => h.tradingsymbol);
      const exchanges = holdings.map(h => h.exchange);
      await pool.query(
        `DELETE FROM stock_holdings
         WHERE user_id = $1
           AND (tradingsymbol, exchange) NOT IN (
             SELECT * FROM unnest($2::text[], $3::text[])
           )`,
        [user_id, symbols, exchanges]
      );
    }

    // Return the freshly synced holdings from DB (with CAGR if available)
    // Cast cagr_1y to float8: pg returns NUMERIC columns as strings, which
    // Gson on Android silently drops when deserializing into Double?.
    const dbResult = await pool.query(
      `SELECT sh.*,
              ac.cagr_1y::float8 AS cagr_1y,
              ac.cagr_3y::float8 AS cagr_3y,
              ac.cagr_5y::float8 AS cagr_5y
       FROM stock_holdings sh
       LEFT JOIN asset_cagr ac
         ON ac.symbol = sh.tradingsymbol AND ac.asset_type = 'stock'
       WHERE sh.user_id = $1
       ORDER BY sh.tradingsymbol`,
      [user_id]
    );

    // Fire-and-forget: recompute CAGR for all synced stocks
    const syncedStocks = dbResult.rows.map((r) => ({ tradingsymbol: r.tradingsymbol, exchange: r.exchange }));
    recomputeStocksCagr(syncedStocks).catch((err) =>
      console.error("[Holdings] CAGR recompute error:", err.message)
    );

    return success(res, { synced: holdings.length, holdings: dbResult.rows });
  } catch (err) {
    console.error("[Holdings] Sync error:", err.message);
    return fail(res, "Failed to sync holdings: " + err.message, 500);
  }
};

/**
 * GET /api/holdings
 * Returns holdings from DB (no Zerodha call).
 */
const getHoldings = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT sh.*,
              ac.cagr_1y::float8 AS cagr_1y,
              ac.cagr_3y::float8 AS cagr_3y,
              ac.cagr_5y::float8 AS cagr_5y
       FROM stock_holdings sh
       LEFT JOIN asset_cagr ac
         ON ac.symbol = sh.tradingsymbol AND ac.asset_type = 'stock'
       WHERE sh.user_id = $1
       ORDER BY sh.tradingsymbol`,
      [user_id]
    );

    return success(res, { holdings: result.rows });
  } catch (err) {
    console.error("[Holdings] Get error:", err.message);
    return fail(res, "Failed to fetch holdings: " + err.message, 500);
  }
};

/**
 * GET /api/holdings/summary
 * Returns aggregated portfolio value and today's P&L for the dashboard.
 */
const getHoldingsSummary = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT
         COALESCE(SUM(sh.current_value), 0)                                    AS total_portfolio_value,
         COALESCE(SUM(sh.day_change * sh.quantity), 0)                         AS today_pnl,
         COALESCE(SUM(sh.current_value * COALESCE(ac.multiplier_1y, 1.0)), 0) AS projected_1y,
         COALESCE(SUM(sh.current_value * COALESCE(ac.multiplier_3y, 1.0)), 0) AS projected_3y,
         COALESCE(SUM(sh.current_value * COALESCE(ac.multiplier_5y, 1.0)), 0) AS projected_5y
       FROM stock_holdings sh
       LEFT JOIN asset_cagr ac
         ON ac.symbol = sh.tradingsymbol AND ac.asset_type = 'stock'
       WHERE sh.user_id = $1`,
      [user_id]
    );

    const { total_portfolio_value, today_pnl, projected_1y, projected_3y, projected_5y } = result.rows[0];
    return success(res, {
      total_portfolio_value: parseFloat(total_portfolio_value),
      today_pnl: parseFloat(today_pnl),
      projected_1y: parseFloat(projected_1y),
      projected_3y: parseFloat(projected_3y),
      projected_5y: parseFloat(projected_5y)
    });
  } catch (err) {
    console.error("[Holdings] Summary error:", err.message);
    return fail(res, "Failed to fetch holdings summary: " + err.message, 500);
  }
};

module.exports = { syncHoldings, getHoldings, getHoldingsSummary };
