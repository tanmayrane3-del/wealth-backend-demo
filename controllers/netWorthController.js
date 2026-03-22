const pool = require("../db");
const { success, fail } = require("../utils/respond");

// ─── Shared Utility ────────────────────────────────────────────────────────
// Used by both the API endpoints and the daily cron job
async function calculateCurrentNetWorth(userId) {
  // Stocks
  const stocks = await pool.query(
    `SELECT COALESCE(SUM(current_value), 0) AS val
     FROM stock_holdings WHERE user_id = $1`,
    [userId]
  );

  // Mutual Funds
  const mf = await pool.query(
    `SELECT COALESCE(SUM(current_value), 0) AS val
     FROM mutual_fund_holdings WHERE user_id = $1`,
    [userId]
  );

  // Metals — quantity × live rate from latest metal_rates_cache row
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

  // Physical Assets
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
      // Use current_market_value if set, else purchase_price
      physicalTotal += parseFloat(asset.current_market_value || asset.purchase_price);
    } else {
      // Vehicle: IT method — 15% WDV per year
      const yearsHeld =
        (today - new Date(asset.purchase_date)) / (365.25 * 24 * 60 * 60 * 1000);
      physicalTotal += parseFloat(asset.purchase_price) * Math.pow(0.85, yearsHeld);
    }
  }

  // Liabilities
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
    const { totalAssets, totalLiabilities, netWorth } =
      await calculateCurrentNetWorth(req.user_id);

    return success(res, {
      total_assets: totalAssets,
      total_liabilities: totalLiabilities,
      net_worth: netWorth,
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
