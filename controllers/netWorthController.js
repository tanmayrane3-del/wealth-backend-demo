const pool = require("../db");
const { success, fail } = require("../utils/respond");
const { fetchGoldDayChangePct } = require("../services/metalRateScraper");

// ─── Shared Utility ────────────────────────────────────────────────────────
// Used by both the API endpoints and the daily cron job
async function calculateCurrentNetWorth(userId) {
  const stocks = await pool.query(
    `SELECT COALESCE(SUM(current_value), 0) AS val
     FROM stock_holdings WHERE user_id = $1`,
    [userId]
  );
  const mf = await pool.query(
    `SELECT COALESCE(SUM(current_value), 0) AS val
     FROM mutual_fund_holdings WHERE user_id = $1`,
    [userId]
  );
  const metals = await pool.query(
    `SELECT COALESCE(SUM(
       mh.quantity_grams * CASE mh.purity
         WHEN '24k' THEN mr.gold_24k_per_gram
         WHEN '22k' THEN mr.gold_22k_per_gram
         ELSE mr.silver_per_gram
       END
     ), 0) AS val
     FROM metal_holdings mh
     CROSS JOIN (SELECT * FROM metal_rates_cache ORDER BY fetched_at DESC LIMIT 1) mr
     WHERE mh.user_id = $1`,
    [userId]
  );
  const physicalRaw = await pool.query(
    `SELECT asset_type, purchase_price, purchase_date, current_market_value
     FROM physical_assets
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  let physicalTotal = 0;
  const today = new Date();
  for (const asset of physicalRaw.rows) {
    if (asset.asset_type === "real_estate") {
      physicalTotal += parseFloat(asset.current_market_value || asset.purchase_price);
    } else {
      const yearsHeld =
        (today - new Date(asset.purchase_date)) / (365.25 * 24 * 60 * 60 * 1000);
      physicalTotal += parseFloat(asset.purchase_price) * Math.pow(0.85, yearsHeld);
    }
  }
  const liabilities = await pool.query(
    `SELECT COALESCE(SUM(outstanding_principal), 0) AS val
     FROM liabilities
     WHERE user_id = $1 AND status = 'active' AND is_deleted = false`,
    [userId]
  );
  const totalAssets =
    parseFloat(stocks.rows[0].val) +
    parseFloat(mf.rows[0].val) +
    parseFloat(metals.rows[0].val) +
    physicalTotal;
  const totalLiabilities = parseFloat(liabilities.rows[0].val);
  const netWorth = totalAssets - totalLiabilities;
  return { totalAssets, totalLiabilities, netWorth };
}

// ─── GET /api/net-worth/current ────────────────────────────────────────────
const getCurrent = async (req, res) => {
  try {
    const userId = req.user_id;

    const [
      stocksBasic,
      mfBasic,
      metalsBasic,
      physicalRaw,
      liabilitiesRes,
      stocksStats,
      mfStats,
      metalsStats,
      otherCount,
      goldDayPct,
    ] = await Promise.all([
      // ── Basic totals ──────────────────────────────────────────────────────
      pool.query(
        `SELECT COALESCE(SUM(current_value), 0)::float8 AS val
         FROM stock_holdings WHERE user_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(COALESCE(current_value, amount_invested)), 0)::float8 AS val
         FROM mutual_fund_holdings WHERE user_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(
           mh.quantity_grams * CASE mh.purity
             WHEN '24k' THEN mr.gold_24k_per_gram
             WHEN '22k' THEN mr.gold_22k_per_gram
             ELSE mr.silver_per_gram
           END
         ), 0)::float8 AS val
         FROM metal_holdings mh
         CROSS JOIN (SELECT * FROM metal_rates_cache ORDER BY fetched_at DESC LIMIT 1) mr
         WHERE mh.user_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT asset_type, purchase_price::float8, purchase_date, current_market_value::float8
         FROM physical_assets WHERE user_id = $1 AND is_active = true`,
        [userId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(outstanding_principal), 0)::float8 AS val
         FROM liabilities WHERE user_id = $1 AND status = 'active' AND is_deleted = false`,
        [userId]
      ),

      // ── Stocks: day change + per-card projections + weighted CAGR numerators + count ──
      pool.query(
        `SELECT
           COALESCE(SUM(sh.day_change * sh.quantity), 0)::float8              AS day_change,
           COALESCE(SUM(sh.current_value * COALESCE(ac.multiplier_1y, 1.0)), 0)::float8 AS proj_1y,
           COALESCE(SUM(sh.current_value * COALESCE(ac.multiplier_3y, 1.0)), 0)::float8 AS proj_3y,
           COALESCE(SUM(sh.current_value * COALESCE(ac.multiplier_5y, 1.0)), 0)::float8 AS proj_5y,
           COALESCE(SUM(sh.current_value * COALESCE(ac.cagr_1y, 0)), 0)::float8         AS cagr1y_wt,
           COALESCE(SUM(sh.current_value * COALESCE(ac.cagr_3y, 0)), 0)::float8         AS cagr3y_wt,
           COALESCE(SUM(sh.current_value * COALESCE(ac.cagr_5y, 0)), 0)::float8         AS cagr5y_wt,
           COUNT(DISTINCT sh.tradingsymbol)::int                              AS stocks_count
         FROM stock_holdings sh
         LEFT JOIN asset_cagr ac ON ac.symbol = sh.tradingsymbol AND ac.asset_type = 'stock'
         WHERE sh.user_id = $1`,
        [userId]
      ),

      // ── MF: day change + per-card projections + weighted CAGR numerators + count ──
      pool.query(
        `SELECT
           COALESCE(SUM(COALESCE(mfh.day_pnl, 0)), 0)::float8                                    AS day_change,
           COALESCE(SUM(COALESCE(mfh.current_value, mfh.amount_invested) * COALESCE(ac.multiplier_1y, 1.0)), 0)::float8 AS proj_1y,
           COALESCE(SUM(COALESCE(mfh.current_value, mfh.amount_invested) * COALESCE(ac.multiplier_3y, 1.0)), 0)::float8 AS proj_3y,
           COALESCE(SUM(COALESCE(mfh.current_value, mfh.amount_invested) * COALESCE(ac.multiplier_5y, 1.0)), 0)::float8 AS proj_5y,
           COALESCE(SUM(COALESCE(mfh.current_value, mfh.amount_invested) * COALESCE(ac.cagr_1y, 0)), 0)::float8        AS cagr1y_wt,
           COALESCE(SUM(COALESCE(mfh.current_value, mfh.amount_invested) * COALESCE(ac.cagr_3y, 0)), 0)::float8        AS cagr3y_wt,
           COALESCE(SUM(COALESCE(mfh.current_value, mfh.amount_invested) * COALESCE(ac.cagr_5y, 0)), 0)::float8        AS cagr5y_wt,
           COUNT(DISTINCT mfh.isin)::int                                                          AS mf_count
         FROM mutual_fund_holdings mfh
         LEFT JOIN asset_cagr ac ON ac.symbol = mfh.isin AND ac.asset_type = 'mf'
         WHERE mfh.user_id = $1`,
        [userId]
      ),

      // ── Metals: per-card projections + weighted CAGR numerators ──────────
      pool.query(
        `SELECT
           COALESCE(SUM(
             mh.quantity_grams * CASE mh.purity
               WHEN '24k' THEN mr.gold_24k_per_gram
               WHEN '22k' THEN mr.gold_22k_per_gram
               ELSE mr.silver_per_gram
             END * COALESCE(ac.multiplier_1y, 1.0)
           ), 0)::float8 AS proj_1y,
           COALESCE(SUM(
             mh.quantity_grams * CASE mh.purity
               WHEN '24k' THEN mr.gold_24k_per_gram
               WHEN '22k' THEN mr.gold_22k_per_gram
               ELSE mr.silver_per_gram
             END * COALESCE(ac.multiplier_3y, 1.0)
           ), 0)::float8 AS proj_3y,
           COALESCE(SUM(
             mh.quantity_grams * CASE mh.purity
               WHEN '24k' THEN mr.gold_24k_per_gram
               WHEN '22k' THEN mr.gold_22k_per_gram
               ELSE mr.silver_per_gram
             END * COALESCE(ac.multiplier_5y, 1.0)
           ), 0)::float8 AS proj_5y,
           COALESCE(SUM(
             mh.quantity_grams * CASE mh.purity
               WHEN '24k' THEN mr.gold_24k_per_gram
               WHEN '22k' THEN mr.gold_22k_per_gram
               ELSE mr.silver_per_gram
             END * COALESCE(ac.cagr_1y, 0)
           ), 0)::float8 AS cagr1y_wt,
           COALESCE(SUM(
             mh.quantity_grams * CASE mh.purity
               WHEN '24k' THEN mr.gold_24k_per_gram
               WHEN '22k' THEN mr.gold_22k_per_gram
               ELSE mr.silver_per_gram
             END * COALESCE(ac.cagr_3y, 0)
           ), 0)::float8 AS cagr3y_wt,
           COALESCE(SUM(
             mh.quantity_grams * CASE mh.purity
               WHEN '24k' THEN mr.gold_24k_per_gram
               WHEN '22k' THEN mr.gold_22k_per_gram
               ELSE mr.silver_per_gram
             END * COALESCE(ac.cagr_5y, 0)
           ), 0)::float8 AS cagr5y_wt
         FROM metal_holdings mh
         CROSS JOIN (SELECT * FROM metal_rates_cache ORDER BY fetched_at DESC LIMIT 1) mr
         LEFT JOIN asset_cagr ac ON ac.asset_type = 'metal' AND ac.symbol = mh.metal_type::text
         WHERE mh.user_id = $1`,
        [userId]
      ),

      // ── Other assets: count ───────────────────────────────────────────────
      pool.query(
        `SELECT COUNT(*)::int AS other_count
         FROM physical_assets WHERE user_id = $1 AND is_active = true`,
        [userId]
      ),

      // ── Gold daily change % ───────────────────────────────────────────────
      fetchGoldDayChangePct().catch(() => 0),
    ]);

    // ── Physical assets total (WDV / market value) ────────────────────────
    let physicalTotal = 0;
    const today = new Date();
    for (const asset of physicalRaw.rows) {
      if (asset.asset_type === "real_estate") {
        physicalTotal += parseFloat(asset.current_market_value || asset.purchase_price);
      } else {
        const yearsHeld =
          (today - new Date(asset.purchase_date)) / (365.25 * 24 * 60 * 60 * 1000);
        physicalTotal += parseFloat(asset.purchase_price) * Math.pow(0.85, yearsHeld);
      }
    }

    // ── Net worth totals ──────────────────────────────────────────────────
    const stocksValue       = parseFloat(stocksBasic.rows[0].val);
    const mfValue           = parseFloat(mfBasic.rows[0].val);
    const metalsValue       = parseFloat(metalsBasic.rows[0].val);
    const totalAssets       = stocksValue + mfValue + metalsValue + physicalTotal;
    const totalLiabilities  = parseFloat(liabilitiesRes.rows[0].val);
    const netWorth          = totalAssets - totalLiabilities;

    // ── Day changes ───────────────────────────────────────────────────────
    const metalsDayChange  = goldDayPct !== 0
      ? metalsValue - metalsValue / (1 + goldDayPct)
      : 0;
    const totalDayChange   = parseFloat(stocksStats.rows[0].day_change)
                           + parseFloat(mfStats.rows[0].day_change)
                           + metalsDayChange;
    const prevNetWorth     = netWorth - totalDayChange;
    const dayChangePct     = prevNetWorth !== 0
      ? (totalDayChange / Math.abs(prevNetWorth)) * 100
      : 0;

    // ── Weighted average portfolio CAGR ───────────────────────────────────
    // Weights = current investment value; physical assets contribute 0 to
    // the numerator (no CAGR data) but are included in the denominator.
    const totalInvValue = totalAssets; // physical is part of denominator
    const cagr1yNumerator = parseFloat(stocksStats.rows[0].cagr1y_wt)
                          + parseFloat(mfStats.rows[0].cagr1y_wt)
                          + parseFloat(metalsStats.rows[0].cagr1y_wt);
    const cagr3yNumerator = parseFloat(stocksStats.rows[0].cagr3y_wt)
                          + parseFloat(mfStats.rows[0].cagr3y_wt)
                          + parseFloat(metalsStats.rows[0].cagr3y_wt);
    const cagr5yNumerator = parseFloat(stocksStats.rows[0].cagr5y_wt)
                          + parseFloat(mfStats.rows[0].cagr5y_wt)
                          + parseFloat(metalsStats.rows[0].cagr5y_wt);

    const weightedCagr1y = totalInvValue > 0 ? cagr1yNumerator / totalInvValue : 0; // decimal e.g. 0.13
    const weightedCagr3y = totalInvValue > 0 ? cagr3yNumerator / totalInvValue : 0;
    const weightedCagr5y = totalInvValue > 0 ? cagr5yNumerator / totalInvValue : 0;

    // ── Net worth projections (weighted CAGR applied to current net worth) ─
    // 1Y: simple growth; 3Y/5Y: compound
    const proj1y = netWorth * (1 + weightedCagr1y);
    const proj3y = netWorth * Math.pow(1 + weightedCagr3y, 3);
    const proj5y = netWorth * Math.pow(1 + weightedCagr5y, 5);

    return success(res, {
      total_assets:        parseFloat(totalAssets.toFixed(2)),
      total_liabilities:   parseFloat(totalLiabilities.toFixed(2)),
      net_worth:           parseFloat(netWorth.toFixed(2)),
      day_change:          parseFloat(totalDayChange.toFixed(2)),
      day_change_pct:      parseFloat(dayChangePct.toFixed(2)),
      projected_1y:        parseFloat(proj1y.toFixed(2)),
      projected_3y:        parseFloat(proj3y.toFixed(2)),
      projected_5y:        parseFloat(proj5y.toFixed(2)),
      cagr_1y:             parseFloat((weightedCagr1y * 100).toFixed(2)),
      stocks_count:        stocksStats.rows[0].stocks_count,
      stocks_proj_1y:      parseFloat(parseFloat(stocksStats.rows[0].proj_1y).toFixed(2)),
      stocks_proj_3y:      parseFloat(parseFloat(stocksStats.rows[0].proj_3y).toFixed(2)),
      stocks_proj_5y:      parseFloat(parseFloat(stocksStats.rows[0].proj_5y).toFixed(2)),
      mf_count:            mfStats.rows[0].mf_count,
      other_assets_count:  otherCount.rows[0].other_count,
    });
  } catch (err) {
    console.error("[net-worth/current GET] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── GET /api/net-worth/snapshots?period=1m|3m|6m|1y|all ──────────────────
const getSnapshots = async (req, res) => {
  try {
    const periodMap = { "1m": 30, "3m": 90, "6m": 180, "1y": 365 };
    const period = (req.query.period || "1m").toLowerCase();

    let query = `
      SELECT snapshot_date,
             total_assets::float8,
             total_liabilities::float8,
             net_worth::float8
      FROM net_worth_snapshots
      WHERE user_id = $1`;

    const params = [req.user_id];

    if (period !== "all" && periodMap[period]) {
      query += ` AND snapshot_date >= CURRENT_DATE - INTERVAL '${periodMap[period]} days'`;
    }

    query += ` ORDER BY snapshot_date ASC`;

    const result = await pool.query(query, params);
    return success(res, { snapshots: result.rows });
  } catch (err) {
    console.error("[net-worth/snapshots GET] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── POST /api/net-worth/snapshot (internal — called by cron, no session) ──
const upsertSnapshotForAllUsers = async (req, res) => {
  try {
    const usersResult = await pool.query(
      `SELECT user_id FROM users WHERE is_active = true`
    );

    let count = 0;
    const errors = [];

    for (const row of usersResult.rows) {
      try {
        const { totalAssets, totalLiabilities, netWorth } =
          await calculateCurrentNetWorth(row.user_id);

        await pool.query(
          `INSERT INTO net_worth_snapshots
             (user_id, snapshot_date, total_assets, total_liabilities, net_worth)
           VALUES ($1, CURRENT_DATE, $2, $3, $4)
           ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
             total_assets      = EXCLUDED.total_assets,
             total_liabilities = EXCLUDED.total_liabilities,
             net_worth         = EXCLUDED.net_worth`,
          [row.user_id, totalAssets, totalLiabilities, netWorth]
        );
        count++;
      } catch (e) {
        console.error(`[net-worth snapshot] Failed for user ${row.user_id}:`, e.message);
        errors.push({ user_id: row.user_id, error: e.message });
      }
    }

    return success(res, { snapshots_written: count, errors });
  } catch (err) {
    console.error("[net-worth/snapshot POST] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

module.exports = {
  getCurrent,
  getSnapshots,
  upsertSnapshotForAllUsers,
  calculateCurrentNetWorth,
};
