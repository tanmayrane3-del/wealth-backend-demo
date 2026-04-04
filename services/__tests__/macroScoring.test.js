// Run with: node --test services/__tests__/macroScoring.test.js
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  applyRules,
  getSignalLabel,
  getConfidence,
  computePrediction,
} = require("../macroScoring");

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Base current object with neutral-ish values for non-tested rules
const baseCurrent = {
  nifty_close:    22000,
  nasdaq_close:   16000,
  usd_inr:        85,       // Rule 4: 0 pts
  hsi_close:      20000,
  oil_brent:      80,       // Rule 5: 0 pts
  india_vix_high: 18,       // Rule 2: < 20 → +1
  fii_net_mtd:    5000,     // Rule 1: > 0 → +1
  dii_net_mtd:    0,
  dxy:            104,
  fed_rate:       5.25,
  rbi_rate:       6.5,
};

// Prev that gives 0 pts for both nasdaq (0% momentum) and trend (0% momentum)
const basePrev = {
  nasdaq_close: 16000,  // nasMom = 0% → -1 pts (> 0 check fails)
  nifty_close:  22000,  // niftyMom = 0% → 0 pts
  hsi_close:    20000,
};

function pts(rules, ruleName) {
  return rules.find((r) => r.rule === ruleName).pts;
}

// ─── applyRules: Rule 1 — Net Institutional Flow ──────────────────────────────

describe("applyRules — net_flow boundaries", () => {
  test("net > 15000 → +2", () => {
    const { rules } = applyRules({ ...baseCurrent, fii_net_mtd: 15001, dii_net_mtd: 0 }, null);
    assert.equal(pts(rules, "net_flow"), 2);
  });

  test("net === 15000 → +1 (not > 15000, but > 0)", () => {
    const { rules } = applyRules({ ...baseCurrent, fii_net_mtd: 15000, dii_net_mtd: 0 }, null);
    assert.equal(pts(rules, "net_flow"), 1);
  });

  test("net === 1 → +1", () => {
    const { rules } = applyRules({ ...baseCurrent, fii_net_mtd: 1, dii_net_mtd: 0 }, null);
    assert.equal(pts(rules, "net_flow"), 1);
  });

  test("net === 0 → -1 (else)", () => {
    const { rules } = applyRules({ ...baseCurrent, fii_net_mtd: 0, dii_net_mtd: 0 }, null);
    assert.equal(pts(rules, "net_flow"), -1);
  });

  test("net === -1 → -1", () => {
    const { rules } = applyRules({ ...baseCurrent, fii_net_mtd: -1, dii_net_mtd: 0 }, null);
    assert.equal(pts(rules, "net_flow"), -1);
  });

  test("net === -15000 → -1 (not < -15000)", () => {
    const { rules } = applyRules({ ...baseCurrent, fii_net_mtd: -15000, dii_net_mtd: 0 }, null);
    assert.equal(pts(rules, "net_flow"), -1);
  });

  test("net < -15000 → -2", () => {
    const { rules } = applyRules({ ...baseCurrent, fii_net_mtd: -15001, dii_net_mtd: 0 }, null);
    assert.equal(pts(rules, "net_flow"), -2);
  });
});

// ─── applyRules: Rule 2 — India VIX ──────────────────────────────────────────

describe("applyRules — vix boundaries", () => {
  test("vix < 15 → +2", () => {
    const { rules } = applyRules({ ...baseCurrent, india_vix_high: 14 }, null);
    assert.equal(pts(rules, "vix"), 2);
  });

  test("vix === 15 → +1 (not < 15, but < 20)", () => {
    const { rules } = applyRules({ ...baseCurrent, india_vix_high: 15 }, null);
    assert.equal(pts(rules, "vix"), 1);
  });

  test("vix === 19 → +1", () => {
    const { rules } = applyRules({ ...baseCurrent, india_vix_high: 19 }, null);
    assert.equal(pts(rules, "vix"), 1);
  });

  test("vix === 20 → -1 (not < 20, not > 25)", () => {
    const { rules } = applyRules({ ...baseCurrent, india_vix_high: 20 }, null);
    assert.equal(pts(rules, "vix"), -1);
  });

  test("vix === 25 → -1 (not > 25)", () => {
    const { rules } = applyRules({ ...baseCurrent, india_vix_high: 25 }, null);
    assert.equal(pts(rules, "vix"), -1);
  });

  test("vix > 25 → -2", () => {
    const { rules } = applyRules({ ...baseCurrent, india_vix_high: 26 }, null);
    assert.equal(pts(rules, "vix"), -2);
  });

  test("vix null → defaults to 18, which is < 20 → +1", () => {
    const { rules } = applyRules({ ...baseCurrent, india_vix_high: null }, null);
    assert.equal(pts(rules, "vix"), 1);
  });
});

// ─── applyRules: Rule 3 — NASDAQ momentum ────────────────────────────────────

describe("applyRules — nasdaq boundaries", () => {
  test("prev null → pts 0", () => {
    const { rules } = applyRules(baseCurrent, null);
    assert.equal(pts(rules, "nasdaq"), 0);
  });

  test("nasMom > 4 → +2", () => {
    // nasMom = (16800 - 16000) / 16000 * 100 = 5%
    const { rules } = applyRules(
      { ...baseCurrent, nasdaq_close: 16800 },
      { ...basePrev, nasdaq_close: 16000 }
    );
    assert.equal(pts(rules, "nasdaq"), 2);
  });

  test("nasMom === 4 → +1 (not > 4, but > 0)", () => {
    // nasMom = (16640 - 16000) / 16000 * 100 = 4%
    const { rules } = applyRules(
      { ...baseCurrent, nasdaq_close: 16640 },
      { ...basePrev, nasdaq_close: 16000 }
    );
    assert.equal(pts(rules, "nasdaq"), 1);
  });

  test("nasMom === 0.1 → +1", () => {
    const { rules } = applyRules(
      { ...baseCurrent, nasdaq_close: 16016 },
      { ...basePrev, nasdaq_close: 16000 }
    );
    assert.equal(pts(rules, "nasdaq"), 1);
  });

  test("nasMom === 0 → -1 (else)", () => {
    const { rules } = applyRules(
      { ...baseCurrent, nasdaq_close: 16000 },
      { ...basePrev, nasdaq_close: 16000 }
    );
    assert.equal(pts(rules, "nasdaq"), -1);
  });

  test("nasMom === -6 → -1 (not < -6)", () => {
    // nasMom = (15040 - 16000) / 16000 * 100 = -6%
    const { rules } = applyRules(
      { ...baseCurrent, nasdaq_close: 15040 },
      { ...basePrev, nasdaq_close: 16000 }
    );
    assert.equal(pts(rules, "nasdaq"), -1);
  });

  test("nasMom < -6 → -2", () => {
    // nasMom ≈ -6.5%
    const { rules } = applyRules(
      { ...baseCurrent, nasdaq_close: 14960 },
      { ...basePrev, nasdaq_close: 16000 }
    );
    assert.equal(pts(rules, "nasdaq"), -2);
  });
});

// ─── applyRules: Rule 4 — USD/INR ────────────────────────────────────────────

describe("applyRules — inr boundaries", () => {
  test("usd_inr < 82 → +1", () => {
    const { rules } = applyRules({ ...baseCurrent, usd_inr: 81 }, null);
    assert.equal(pts(rules, "inr"), 1);
  });

  test("usd_inr === 82 → 0 (not < 82, not > 90)", () => {
    const { rules } = applyRules({ ...baseCurrent, usd_inr: 82 }, null);
    assert.equal(pts(rules, "inr"), 0);
  });

  test("usd_inr === 90 → 0 (not > 90)", () => {
    const { rules } = applyRules({ ...baseCurrent, usd_inr: 90 }, null);
    assert.equal(pts(rules, "inr"), 0);
  });

  test("usd_inr > 90 → -1", () => {
    const { rules } = applyRules({ ...baseCurrent, usd_inr: 91 }, null);
    assert.equal(pts(rules, "inr"), -1);
  });
});

// ─── applyRules: Rule 5 — Brent Crude Oil ────────────────────────────────────

describe("applyRules — oil boundaries", () => {
  test("oil_brent < 66 → +1", () => {
    const { rules } = applyRules({ ...baseCurrent, oil_brent: 65 }, null);
    assert.equal(pts(rules, "oil"), 1);
  });

  test("oil_brent === 66 → 0 (not < 66, not > 100)", () => {
    const { rules } = applyRules({ ...baseCurrent, oil_brent: 66 }, null);
    assert.equal(pts(rules, "oil"), 0);
  });

  test("oil_brent === 100 → 0 (not > 100)", () => {
    const { rules } = applyRules({ ...baseCurrent, oil_brent: 100 }, null);
    assert.equal(pts(rules, "oil"), 0);
  });

  test("oil_brent > 100 → -1", () => {
    const { rules } = applyRules({ ...baseCurrent, oil_brent: 101 }, null);
    assert.equal(pts(rules, "oil"), -1);
  });
});

// ─── applyRules: Rule 6 — Nifty trend ────────────────────────────────────────

describe("applyRules — trend boundaries", () => {
  test("prev null → pts 0", () => {
    const { rules } = applyRules(baseCurrent, null);
    assert.equal(pts(rules, "trend"), 0);
  });

  test("niftyMom > 5 → +1 (uptrend)", () => {
    // niftyMom ≈ 6%
    const { rules } = applyRules(
      { ...baseCurrent, nifty_close: 23320 },
      { ...basePrev, nifty_close: 22000 }
    );
    assert.equal(pts(rules, "trend"), 1);
  });

  test("niftyMom === 5 → 0 (not > 5, not < -5)", () => {
    // niftyMom = (23100 - 22000) / 22000 * 100 = 5%
    const { rules } = applyRules(
      { ...baseCurrent, nifty_close: 23100 },
      { ...basePrev, nifty_close: 22000 }
    );
    assert.equal(pts(rules, "trend"), 0);
  });

  test("niftyMom === -5 → 0 (not < -5)", () => {
    const { rules } = applyRules(
      { ...baseCurrent, nifty_close: 20900 },
      { ...basePrev, nifty_close: 22000 }
    );
    assert.equal(pts(rules, "trend"), 0);
  });

  test("niftyMom < -5 → +1 (mean reversion signal)", () => {
    // niftyMom ≈ -6%
    const { rules } = applyRules(
      { ...baseCurrent, nifty_close: 20680 },
      { ...basePrev, nifty_close: 22000 }
    );
    assert.equal(pts(rules, "trend"), 1);
  });
});

// ─── applyRules: total equals sum of all rule pts ────────────────────────────

describe("applyRules — total equals sum of rules", () => {
  test("total is correct sum of all 6 rule pts", () => {
    const { total, rules } = applyRules(baseCurrent, basePrev);
    const expected = rules.reduce((sum, r) => sum + r.pts, 0);
    assert.equal(total, expected);
  });

  test("total with prev null: rules 3 and 6 each contribute 0", () => {
    const { total, rules } = applyRules(baseCurrent, null);
    assert.equal(pts(rules, "nasdaq"), 0);
    assert.equal(pts(rules, "trend"),  0);
    const expected = rules.reduce((sum, r) => sum + r.pts, 0);
    assert.equal(total, expected);
  });
});

// ─── getSignalLabel: all boundary scores ─────────────────────────────────────

describe("getSignalLabel — all boundary scores", () => {
  const cases = [
    [-5, "strong_bear"],
    [-4, "mild_bear"],
    [-3, "mild_bear"],
    [-2, "cautious_bear"],
    [-1, "cautious_bear"],
    [ 0, "neutral"],
    [ 1, "cautious_bull"],
    [ 2, "cautious_bull"],
    [ 3, "mild_bull"],
    [ 4, "mild_bull"],
    [ 5, "strong_bull"],
    [ 6, "strong_bull"],
  ];

  for (const [score, expected] of cases) {
    test(`score ${score} → '${expected}'`, () => {
      assert.equal(getSignalLabel(score), expected);
    });
  }
});

// ─── getConfidence: all four tiers ───────────────────────────────────────────

describe("getConfidence — all four tiers", () => {
  test("absScore 0 → abstain", () => {
    assert.deepEqual(getConfidence(0), { tier: "abstain", pct: "N/A" });
  });

  test("absScore 1 → moderate", () => {
    assert.deepEqual(getConfidence(1), { tier: "moderate", pct: "60-65%" });
  });

  test("absScore 3 → high", () => {
    assert.deepEqual(getConfidence(3), { tier: "high", pct: "65-70%" });
  });

  test("absScore 5 → very_high", () => {
    assert.deepEqual(getConfidence(5), { tier: "very_high", pct: "68-75%" });
  });
});

// ─── computePrediction ────────────────────────────────────────────────────────

describe("computePrediction", () => {
  const nifty = 22000;

  test("score +2 with valid scoreAccuracyRow uses row values", () => {
    const row = { accuracy_pct: 62.5, total_months: 15, pct_positive: 60, avg_return: 2.1 };
    const pred = computePrediction(2, nifty, row);
    assert.equal(pred.predicted_direction, "bull");
    assert.equal(pred.predicted_return_pct, 2.1);
    assert.equal(pred.target_nifty, Math.round(nifty * (1 + 2.1 / 100)));
    assert.equal(pred.accuracy_pct, 62.5);
    assert.equal(pred.historical_months, 15);
    assert.equal(pred.pct_positive, 60);
  });

  test("score -3 with null scoreAccuracyRow → default -1.5 return, bear direction", () => {
    const pred = computePrediction(-3, nifty, null);
    assert.equal(pred.predicted_direction, "bear");
    assert.equal(pred.predicted_return_pct, -1.5);
    assert.equal(pred.target_nifty, Math.round(nifty * (1 + (-1.5) / 100)));
    assert.equal(pred.accuracy_pct, null);
    assert.equal(pred.historical_months, 0);
    assert.equal(pred.pct_positive, null);
  });

  test("score 0 → direction neutral, return 0", () => {
    const pred = computePrediction(0, nifty, null);
    assert.equal(pred.predicted_direction, "neutral");
    assert.equal(pred.predicted_return_pct, 0);
    assert.equal(pred.target_nifty, nifty);
  });

  test("score +1 with null row → default +1.5 return, bull direction", () => {
    const pred = computePrediction(1, nifty, null);
    assert.equal(pred.predicted_direction, "bull");
    assert.equal(pred.predicted_return_pct, 1.5);
  });

  test("target_nifty_low < target_nifty < target_nifty_high always holds", () => {
    const scores = [-5, -3, -1, 0, 1, 3, 5];
    for (const score of scores) {
      const pred = computePrediction(score, nifty, null);
      assert.ok(
        pred.target_nifty_low < pred.target_nifty &&
        pred.target_nifty < pred.target_nifty_high,
        `Failed for score ${score}: low=${pred.target_nifty_low} mid=${pred.target_nifty} high=${pred.target_nifty_high}`
      );
    }
  });

  test("target_nifty_low < target_nifty < target_nifty_high with scoreAccuracyRow", () => {
    const row = { accuracy_pct: 70, total_months: 20, pct_positive: 65, avg_return: 3.5 };
    const pred = computePrediction(4, nifty, row);
    assert.ok(pred.target_nifty_low < pred.target_nifty && pred.target_nifty < pred.target_nifty_high);
  });
});
