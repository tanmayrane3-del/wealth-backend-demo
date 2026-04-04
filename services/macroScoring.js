// Pure scoring functions — no DB calls, no external imports.

// ─── applyRules ───────────────────────────────────────────────────────────────
// current: { nifty_close, nasdaq_close, usd_inr, hsi_close, oil_brent,
//            india_vix_high, fii_net_mtd, dii_net_mtd }
// prev:    { nifty_close, nasdaq_close, hsi_close } | null
// Returns: { total: number, rules: [{ rule: string, pts: number }] }
function applyRules(current, prev) {
  const rules = [];

  // Rule 1 — Net Institutional Flow
  const net = (current.fii_net_mtd || 0) + (current.dii_net_mtd || 0);
  let pts1;
  if      (net > 15000)  pts1 =  2;
  else if (net > 0)      pts1 =  1;
  else if (net < -15000) pts1 = -2;
  else                   pts1 = -1;
  rules.push({ rule: "net_flow", pts: pts1 });

  // Rule 2 — India VIX Monthly High
  const vix = current.india_vix_high ?? 18;
  let pts2;
  if      (vix < 15) pts2 =  2;
  else if (vix < 20) pts2 =  1;
  else if (vix > 25) pts2 = -2;
  else               pts2 = -1;
  rules.push({ rule: "vix", pts: pts2 });

  // Rule 3 — NASDAQ 1-month momentum (0 if no prev)
  let pts3 = 0;
  if (prev !== null) {
    const nasMom = (current.nasdaq_close - prev.nasdaq_close) / prev.nasdaq_close * 100;
    if      (nasMom > 4)  pts3 =  2;
    else if (nasMom > 0)  pts3 =  1;
    else if (nasMom < -6) pts3 = -2;
    else                  pts3 = -1;
  }
  rules.push({ rule: "nasdaq", pts: pts3 });

  // Rule 4 — USD/INR
  let pts4;
  if      (current.usd_inr < 82) pts4 =  1;
  else if (current.usd_inr > 90) pts4 = -1;
  else                           pts4 =  0;
  rules.push({ rule: "inr", pts: pts4 });

  // Rule 5 — Brent Crude Oil
  let pts5;
  if      (current.oil_brent < 66)  pts5 =  1;
  else if (current.oil_brent > 100) pts5 = -1;
  else                              pts5 =  0;
  rules.push({ rule: "oil", pts: pts5 });

  // Rule 6 — Nifty 1-month trend (0 if no prev)
  let pts6 = 0;
  if (prev !== null) {
    const niftyMom = (current.nifty_close - prev.nifty_close) / prev.nifty_close * 100;
    if (niftyMom > 5 || niftyMom < -5) pts6 = 1;
  }
  rules.push({ rule: "trend", pts: pts6 });

  const total = rules.reduce((sum, r) => sum + r.pts, 0);
  return { total, rules };
}

// ─── getSignalLabel ───────────────────────────────────────────────────────────
function getSignalLabel(score) {
  if (score >= 5)  return "strong_bull";
  if (score >= 3)  return "mild_bull";
  if (score >= 1)  return "cautious_bull";
  if (score === 0) return "neutral";
  if (score >= -2) return "cautious_bear";
  if (score >= -4) return "mild_bear";
  return "strong_bear";
}

// ─── getConfidence ────────────────────────────────────────────────────────────
function getConfidence(absScore) {
  if (absScore >= 5) return { tier: "very_high", pct: "68-75%" };
  if (absScore >= 3) return { tier: "high",      pct: "65-70%" };
  if (absScore >= 1) return { tier: "moderate",  pct: "60-65%" };
  return               { tier: "abstain",   pct: "N/A"    };
}

// ─── computePrediction ────────────────────────────────────────────────────────
// scoreAccuracyRow: row from macro_score_accuracy, or null
function computePrediction(totalScore, currentNifty, scoreAccuracyRow) {
  const predicted_direction =
    totalScore > 0 ? "bull" : totalScore < 0 ? "bear" : "neutral";

  let predicted_return_pct;
  if (scoreAccuracyRow != null) {
    predicted_return_pct = scoreAccuracyRow.avg_return;
  } else if (totalScore > 0) {
    predicted_return_pct = 1.5;
  } else if (totalScore < 0) {
    predicted_return_pct = -1.5;
  } else {
    predicted_return_pct = 0;
  }

  const ret = Number(predicted_return_pct);
  const target_nifty      = Math.round(currentNifty * (1 + ret / 100));
  const target_nifty_low  = Math.round(currentNifty * (1 + (ret - 3.5) / 100));
  const target_nifty_high = Math.round(currentNifty * (1 + (ret + 3.5) / 100));

  return {
    predicted_direction,
    predicted_return_pct,
    target_nifty,
    target_nifty_low,
    target_nifty_high,
    accuracy_pct:      scoreAccuracyRow?.accuracy_pct      ?? null,
    historical_months: scoreAccuracyRow?.total_months      ?? 0,
    pct_positive:      scoreAccuracyRow?.pct_positive      ?? null,
  };
}

module.exports = { applyRules, getSignalLabel, getConfidence, computePrediction };
