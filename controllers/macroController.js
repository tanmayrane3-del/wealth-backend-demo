const pool = require("../db");
const { success, fail } = require("../utils/respond");

// ─── GET /api/macro/signal ────────────────────────────────────────────────────
const getSignal = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM macro_monthly_signal ORDER BY month DESC LIMIT 1`
    );
    return success(res, result.rows[0] || null);
  } catch (err) {
    console.error("[macro/signal] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── GET /api/macro/history ───────────────────────────────────────────────────
const getHistory = async (req, res) => {
  const months = Math.min(parseInt(req.query.months) || 12, 24);
  try {
    const result = await pool.query(
      `SELECT m.month, m.total_score, m.signal, m.nifty_close,
              m.fii_net_mtd, m.dii_net_mtd, m.net_flow_mtd,
              m.confidence, m.trading_day_n, m.predicted_direction,
              m.predicted_return_pct, m.target_nifty, m.accuracy_at_score,
              m.final_score, m.final_direction, m.is_final,
              b.actual_ret_1m,
              CASE
                WHEN b.actual_ret_1m IS NULL THEN NULL
                WHEN COALESCE(m.final_direction, m.predicted_direction) = 'bull'
                     AND b.actual_ret_1m > 0 THEN true
                WHEN COALESCE(m.final_direction, m.predicted_direction) = 'bear'
                     AND b.actual_ret_1m < 0 THEN true
                ELSE false
              END AS is_correct
       FROM macro_monthly_signal m
       LEFT JOIN macro_backtest_results b ON b.month = m.month
       ORDER BY m.month DESC
       LIMIT $1`,
      [months]
    );
    return success(res, result.rows);
  } catch (err) {
    console.error("[macro/history] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── GET /api/macro/accuracy ──────────────────────────────────────────────────
const getAccuracy = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM macro_score_accuracy ORDER BY score ASC`
    );
    return success(res, result.rows);
  } catch (err) {
    console.error("[macro/accuracy] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── GET /api/macro/daily ─────────────────────────────────────────────────────
const getDailyFactors = async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  try {
    const result = await pool.query(
      `SELECT date, nifty_close, nasdaq_close, oil_brent,
              usd_inr, india_vix_high, fii_net, dii_net
       FROM macro_factors_daily
       ORDER BY date DESC
       LIMIT $1`,
      [days]
    );
    return success(res, result.rows);
  } catch (err) {
    console.error("[macro/daily] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── GET /api/macro/backtest ──────────────────────────────────────────────────
const getBacktest = async (req, res) => {
  const months = Math.min(parseInt(req.query.months) || 24, 60);
  try {
    const [rowsResult, summaryResult] = await Promise.all([
      pool.query(
        `SELECT month, score, predicted_direction, actual_ret_1m, correct
         FROM macro_backtest_results
         ORDER BY month DESC LIMIT $1`,
        [months]
      ),
      pool.query(
        `SELECT
           COUNT(*)                                               AS total_months,
           COUNT(*) FILTER (WHERE actual_ret_1m IS NOT NULL)     AS with_returns,
           COUNT(*) FILTER (WHERE correct = true)                AS correct_calls,
           COUNT(*) FILTER (WHERE correct = false)               AS wrong_calls,
           ROUND(
             COUNT(*) FILTER (WHERE correct = true)::numeric /
             NULLIF(COUNT(*) FILTER (WHERE correct IS NOT NULL), 0) * 100, 1
           )                                                     AS accuracy_pct
         FROM macro_backtest_results`
      ),
    ]);
    return success(res, { rows: rowsResult.rows, summary: summaryResult.rows[0] });
  } catch (err) {
    console.error("[macro/backtest] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── GET /api/macro/health  (no auth) ────────────────────────────────────────
const getHealth = async (req, res) => {
  try {
    const [dailyResult, signalResult] = await Promise.all([
      pool.query(`SELECT MAX(date) AS last_date FROM macro_factors_daily`),
      pool.query(
        `SELECT total_score, signal, predicted_direction, target_nifty
         FROM macro_monthly_signal ORDER BY month DESC LIMIT 1`
      ),
    ]);

    const rawDate = dailyResult.rows[0]?.last_date;
    const lastFetchDate = rawDate
      ? new Date(rawDate).toISOString().split("T")[0]
      : null;

    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    });

    const todayFetched = lastFetchDate === today;

    const signalRow = signalResult.rows[0] || null;

    return success(res, {
      status: "ok",
      last_fetch_date: lastFetchDate,
      today_fetched: todayFetched,
      current_signal: signalRow,
    });
  } catch (err) {
    console.error("[macro/health] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── POST /api/macro/trigger  (admin key auth, no validateSession) ────────────
const triggerJob = (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_API_KEY) {
    return fail(res, "Unauthorized", 401);
  }

  success(res, { success: true, message: "Job triggered" });

  const { runMacroJob } = require("../jobs/macroJob");
  runMacroJob().catch((err) =>
    console.error("[macro/trigger] Job error:", err.message)
  );
};

module.exports = { getSignal, getHistory, getAccuracy, getDailyFactors, getBacktest, getHealth, triggerJob };
