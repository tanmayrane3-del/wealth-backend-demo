const cron = require("node-cron");
const { fetchMacroFactorsFromSheet } = require("../services/googleSheetsService");
const { applyRules, getSignalLabel, getConfidence, computePrediction } = require("../services/macroScoring");
const pool = require("../db");

// ─── runMacroJob ──────────────────────────────────────────────────────────────
async function runMacroJob() {
  // STEP A — Log start
  console.log("[MacroJob] Starting at", new Date().toISOString());

  // STEP B — Fetch from Google Sheet
  let sheetData;
  try {
    sheetData = await fetchMacroFactorsFromSheet();
  } catch (err) {
    console.error("[MacroJob] Sheet fetch failed:", err.message);
    return;
  }

  // STEP C — Today's date string in IST (YYYY-MM-DD)
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });

  // STEP D — Upsert today into macro_factors_daily
  await pool.query(
    `INSERT INTO macro_factors_daily
       (date, nifty_close, nasdaq_close, oil_brent, usd_inr, dxy,
        india_vix_high, fii_net, dii_net, fed_rate, rbi_rate, hsi_close)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (date) DO UPDATE SET
       nifty_close    = EXCLUDED.nifty_close,
       nasdaq_close   = EXCLUDED.nasdaq_close,
       oil_brent      = EXCLUDED.oil_brent,
       usd_inr        = EXCLUDED.usd_inr,
       dxy            = EXCLUDED.dxy,
       india_vix_high = EXCLUDED.india_vix_high,
       fii_net        = EXCLUDED.fii_net,
       dii_net        = EXCLUDED.dii_net,
       fed_rate       = EXCLUDED.fed_rate,
       rbi_rate       = EXCLUDED.rbi_rate,
       hsi_close      = EXCLUDED.hsi_close`,
    [
      today,
      sheetData.nifty_close,
      sheetData.nasdaq_close,
      sheetData.oil_brent,
      sheetData.usd_inr,
      sheetData.dxy,
      sheetData.india_vix_high,
      sheetData.fii_net,
      sheetData.dii_net,
      sheetData.fed_rate,
      sheetData.rbi_rate,
      sheetData.hsi_close,
    ]
  );

  // STEP E — Determine month start date in IST
  const [todayYear, todayMonth] = today.split("-");
  const monthStart = `${todayYear}-${todayMonth}-01`;

  // STEP F — Fetch all daily rows for this month (includes today)
  const monthResult = await pool.query(
    `SELECT date, nifty_close, nasdaq_close, oil_brent, usd_inr, dxy,
            india_vix_high, fii_net, dii_net, fed_rate, rbi_rate, hsi_close
     FROM macro_factors_daily
     WHERE date >= $1
     ORDER BY date ASC`,
    [monthStart]
  );
  const monthRows = monthResult.rows;

  // STEP G — Compute month-to-date aggregates
  const fii_net_mtd = monthRows.reduce((sum, r) => sum + (parseFloat(r.fii_net) || 0), 0);
  const dii_net_mtd = monthRows.reduce((sum, r) => sum + (parseFloat(r.dii_net) || 0), 0);
  const net_flow_mtd = fii_net_mtd + dii_net_mtd;

  const nonNullVix = monthRows.filter((r) => r.india_vix_high !== null);
  const india_vix_high_mtd =
    nonNullVix.length > 0
      ? Math.max(...nonNullVix.map((r) => parseFloat(r.india_vix_high)))
      : null;

  const trading_day_n = monthRows.length;

  // STEP H — Get previous month's last row
  const prevResult = await pool.query(
    `SELECT nasdaq_close, nifty_close, hsi_close
     FROM macro_factors_daily
     WHERE date < $1
     ORDER BY date DESC
     LIMIT 1`,
    [monthStart]
  );
  const prev = prevResult.rows.length > 0 ? prevResult.rows[0] : null;

  // STEP I — Build scoring input (latest row + MTD overrides)
  const latestRow = monthRows[monthRows.length - 1];
  const current = {
    ...latestRow,
    india_vix_high: india_vix_high_mtd,
    fii_net_mtd,
    dii_net_mtd,
  };

  // STEP J — Apply scoring rules
  const { total, rules } = applyRules(current, prev);
  const signal     = getSignalLabel(total);
  const confidence = getConfidence(Math.abs(total));

  // STEP K — Fetch matching accuracy row
  let scoreAccuracyRow = null;
  try {
    const accResult = await pool.query(
      `SELECT * FROM macro_score_accuracy WHERE score = $1`,
      [total]
    );
    scoreAccuracyRow = accResult.rows[0] || null;
  } catch (err) {
    console.error("[MacroJob] Accuracy lookup failed:", err.message);
  }

  // STEP L — Compute prediction
  const prediction = computePrediction(total, current.nifty_close, scoreAccuracyRow, prev?.nifty_close ?? null);

  // STEP M — Determine is_final
  const dayOfMonth = parseInt(today.split("-")[2]);
  const is_final = dayOfMonth >= 28;

  // STEP N — Upsert into macro_monthly_signal
  // Pre-query: check if final_score is already locked for this month
  const existingRow = await pool.query(
    `SELECT final_score FROM macro_monthly_signal WHERE month = $1`,
    [monthStart]
  );
  const existingFinalScore = existingRow.rows[0]?.final_score ?? null;
  const shouldLockFinal = is_final && existingFinalScore === null;

  // Main upsert — never touches final_* columns (those are locked separately below)
  await pool.query(
    `INSERT INTO macro_monthly_signal (
       month, nifty_close, nasdaq_close, oil_brent, usd_inr, dxy,
       india_vix_high, fii_net_mtd, dii_net_mtd, net_flow_mtd,
       fed_rate, rbi_rate, hsi_close,
       prev_nasdaq, prev_nifty, prev_hsi,
       score_net_flow, score_vix, score_nasdaq, score_inr, score_oil, score_trend,
       total_score, signal, confidence, confidence_pct,
       data_as_of, trading_day_n, is_final,
       predicted_direction, predicted_return_pct,
       target_nifty, target_nifty_low, target_nifty_high,
       accuracy_at_score, historical_months, pct_positive,
       updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
       $14,$15,$16,$17,$18,$19,$20,$21,$22,
       $23,$24,$25,$26,$27,$28,$29,
       $30,$31,$32,$33,$34,$35,$36,$37,$38
     )
     ON CONFLICT (month) DO UPDATE SET
       nifty_close          = EXCLUDED.nifty_close,
       nasdaq_close         = EXCLUDED.nasdaq_close,
       oil_brent            = EXCLUDED.oil_brent,
       usd_inr              = EXCLUDED.usd_inr,
       dxy                  = EXCLUDED.dxy,
       india_vix_high       = EXCLUDED.india_vix_high,
       fii_net_mtd          = EXCLUDED.fii_net_mtd,
       dii_net_mtd          = EXCLUDED.dii_net_mtd,
       net_flow_mtd         = EXCLUDED.net_flow_mtd,
       fed_rate             = EXCLUDED.fed_rate,
       rbi_rate             = EXCLUDED.rbi_rate,
       hsi_close            = EXCLUDED.hsi_close,
       prev_nasdaq          = EXCLUDED.prev_nasdaq,
       prev_nifty           = EXCLUDED.prev_nifty,
       prev_hsi             = EXCLUDED.prev_hsi,
       score_net_flow       = EXCLUDED.score_net_flow,
       score_vix            = EXCLUDED.score_vix,
       score_nasdaq         = EXCLUDED.score_nasdaq,
       score_inr            = EXCLUDED.score_inr,
       score_oil            = EXCLUDED.score_oil,
       score_trend          = EXCLUDED.score_trend,
       total_score          = EXCLUDED.total_score,
       signal               = EXCLUDED.signal,
       confidence           = EXCLUDED.confidence,
       confidence_pct       = EXCLUDED.confidence_pct,
       data_as_of           = EXCLUDED.data_as_of,
       trading_day_n        = EXCLUDED.trading_day_n,
       is_final             = EXCLUDED.is_final,
       predicted_direction  = EXCLUDED.predicted_direction,
       predicted_return_pct = EXCLUDED.predicted_return_pct,
       target_nifty         = EXCLUDED.target_nifty,
       target_nifty_low     = EXCLUDED.target_nifty_low,
       target_nifty_high    = EXCLUDED.target_nifty_high,
       accuracy_at_score    = EXCLUDED.accuracy_at_score,
       historical_months    = EXCLUDED.historical_months,
       pct_positive         = EXCLUDED.pct_positive,
       updated_at           = EXCLUDED.updated_at`,
    [
      monthStart,                                              // $1
      current.nifty_close,                                    // $2
      current.nasdaq_close,                                   // $3
      current.oil_brent,                                      // $4
      current.usd_inr,                                        // $5
      current.dxy,                                            // $6
      india_vix_high_mtd,                                     // $7
      fii_net_mtd,                                            // $8
      dii_net_mtd,                                            // $9
      net_flow_mtd,                                           // $10
      current.fed_rate,                                       // $11
      current.rbi_rate,                                       // $12
      current.hsi_close,                                      // $13
      prev?.nasdaq_close ?? null,                             // $14
      prev?.nifty_close  ?? null,                             // $15
      prev?.hsi_close    ?? null,                             // $16
      rules.find((r) => r.rule === "net_flow")?.pts ?? null,  // $17
      rules.find((r) => r.rule === "vix")?.pts      ?? null,  // $18
      rules.find((r) => r.rule === "nasdaq")?.pts   ?? null,  // $19
      rules.find((r) => r.rule === "inr")?.pts      ?? null,  // $20
      rules.find((r) => r.rule === "oil")?.pts      ?? null,  // $21
      rules.find((r) => r.rule === "trend")?.pts    ?? null,  // $22
      total,                                                  // $23
      signal,                                                 // $24
      confidence.tier,                                        // $25
      confidence.pct,                                         // $26
      today,                                                  // $27
      trading_day_n,                                          // $28
      is_final,                                               // $29
      prediction.predicted_direction,                         // $30
      prediction.predicted_return_pct,                        // $31
      prediction.target_nifty,                                // $32
      prediction.target_nifty_low,                            // $33
      prediction.target_nifty_high,                           // $34
      prediction.accuracy_pct,                                // $35
      prediction.historical_months,                           // $36
      prediction.pct_positive,                                // $37
      new Date().toISOString(),                               // $38
    ]
  );

  // Lock final_* columns once on day 28 — separate UPDATE, never overwrites
  if (shouldLockFinal) {
    await pool.query(
      `UPDATE macro_monthly_signal
       SET final_score        = $1,
           final_signal       = $2,
           final_direction    = $3,
           final_target_nifty = $4,
           final_return_pct   = $5,
           score_locked_at    = $6
       WHERE month = $7 AND final_score IS NULL`,
      [
        total,
        signal,
        prediction.predicted_direction,
        prediction.target_nifty,
        prediction.predicted_return_pct,
        today,
        monthStart,
      ]
    );
    console.log("[MacroJob] Final score locked for", monthStart, "| score:", total, "| signal:", signal);
  }

  // STEP O — Log completion
  console.log(
    "[MacroJob] Done — score:", total,
    "| signal:", signal,
    "| direction:", prediction.predicted_direction,
    "| target: ₹", prediction.target_nifty,
    "| day", trading_day_n, "of month"
  );

  // STEP P — Auto-populate macro_backtest_results (first trading day of month only)
  if (trading_day_n === 1) {
    updateBacktest(monthStart);
  }
}

// ─── updateBacktest ───────────────────────────────────────────────────────────
// Runs on first trading day of each month. Retries every 5 min until success.
async function updateBacktest(monthStart) {
  const MAX_RETRIES = 20; // ~100 minutes of retries
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      // Previous month start  (e.g. monthStart='2026-05-01' → '2026-04-01')
      const d1 = new Date(monthStart + "T00:00:00Z");
      d1.setUTCMonth(d1.getUTCMonth() - 1);
      const prevMonthStart = d1.toISOString().slice(0, 7) + "-01";

      // Two months ago start  (e.g. '2026-03-01')
      const d2 = new Date(monthStart + "T00:00:00Z");
      d2.setUTCMonth(d2.getUTCMonth() - 2);
      const prevPrevMonthStart = d2.toISOString().slice(0, 7) + "-01";

      // Step 1 — Previous month's last Nifty close
      const prevDailyResult = await pool.query(
        `SELECT nifty_close FROM macro_factors_daily
         WHERE date >= $1 AND date < $2
         ORDER BY date DESC LIMIT 1`,
        [prevMonthStart, monthStart]
      );
      if (prevDailyResult.rows.length === 0) {
        console.warn("[MacroJob] Backtest: no daily rows for", prevMonthStart, "— skipping");
        return;
      }
      const prevMonthFinalNifty = parseFloat(prevDailyResult.rows[0].nifty_close);

      // Step 2 — Month before that's last Nifty close
      const prevPrevDailyResult = await pool.query(
        `SELECT nifty_close FROM macro_factors_daily
         WHERE date >= $1 AND date < $2
         ORDER BY date DESC LIMIT 1`,
        [prevPrevMonthStart, prevMonthStart]
      );
      if (prevPrevDailyResult.rows.length === 0) {
        console.warn("[MacroJob] Backtest: no daily rows for", prevPrevMonthStart, "— skipping");
        return;
      }
      const prevPrevMonthFinalNifty = parseFloat(prevPrevDailyResult.rows[0].nifty_close);

      // Step 3 — Actual return: prev month close vs prev-prev month close
      const actual_ret_1m = parseFloat(
        ((prevMonthFinalNifty - prevPrevMonthFinalNifty) / prevPrevMonthFinalNifty * 100).toFixed(4)
      );

      // Step 4 — Get previous month's signal — prefer final_* (locked) over total_score
      const signalResult = await pool.query(
        `SELECT total_score, predicted_direction, final_score, final_direction
         FROM macro_monthly_signal
         WHERE month = $1`,
        [prevMonthStart]
      );
      if (signalResult.rows.length === 0) {
        const existingBacktest = await pool.query(
          `SELECT actual_ret_1m FROM macro_backtest_results
           WHERE month = $1 AND actual_ret_1m IS NOT NULL`,
          [prevMonthStart]
        );
        if (existingBacktest.rows.length > 0) {
          // Already seeded as historical data — nothing to do
          return;
        }
        console.warn("[MacroJob] Backtest: no signal row for", prevMonthStart, "— genuine gap, skipping");
        return;
      }
      const prevSignal = signalResult.rows[0];

      let scoreToUse, dirToUse;
      if (prevSignal.final_score !== null) {
        scoreToUse = prevSignal.final_score;
        dirToUse   = prevSignal.final_direction;
      } else {
        console.warn("[MacroJob] Backtest: final_score not set for", prevMonthStart, "— falling back to total_score");
        scoreToUse = prevSignal.total_score;
        dirToUse   = prevSignal.predicted_direction;
      }

      // Step 5 — Determine if prediction was correct
      let correct = null;
      if (dirToUse === "bull")      correct = actual_ret_1m > 0;
      else if (dirToUse === "bear") correct = actual_ret_1m < 0;
      // neutral → correct stays null

      // Step 6 — Upsert into macro_backtest_results
      await pool.query(
        `INSERT INTO macro_backtest_results
           (month, score, actual_ret_1m, predicted_direction, correct)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (month) DO UPDATE SET
           score               = EXCLUDED.score,
           actual_ret_1m       = EXCLUDED.actual_ret_1m,
           predicted_direction = EXCLUDED.predicted_direction,
           correct             = EXCLUDED.correct`,
        [prevMonthStart, scoreToUse, actual_ret_1m, dirToUse, correct]
      );

      // Step 7 — Log
      console.log(
        "[MacroJob] Backtest updated for", prevMonthStart,
        "| actual:", actual_ret_1m.toFixed(2) + "%",
        "| score used:", scoreToUse,
        "| correct:", correct
      );
      return; // success — stop retrying

    } catch (err) {
      attempt++;
      console.error(
        `[MacroJob] Backtest attempt ${attempt} failed:`, err.message,
        attempt < MAX_RETRIES ? "— retrying in 5 min" : "— giving up"
      );
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
      }
    }
  }
}

// ─── startMacroCron ──────────────────────────────────────────────────────────
function startMacroCron() {
  const handler = () =>
    runMacroJob().catch((err) =>
      console.error("[MacroJob] Cron run error:", err.message)
    );

  cron.schedule("30 3 * * 1-5", handler);  // 9:00 AM IST
  cron.schedule("30 12 * * 1-5", handler); // 6:00 PM IST
  console.log("[MacroJob] Cron registered — fires at 03:30 UTC (9:00am IST) and 12:30 UTC (6:00pm IST) weekdays");
}

module.exports = { startMacroCron, runMacroJob };
