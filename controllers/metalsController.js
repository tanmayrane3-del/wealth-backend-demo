const pool = require("../db");
const { success, fail } = require("../utils/respond");
const { getLatestRates, fetchGoldDayChangePct } = require("../services/metalRateScraper");
const { recomputeMetalsCagr } = require("../services/cagrCalculator");

const VALID_METAL_TYPES = ["physical_gold", "digital_gold", "sgb"];
const VALID_SUB_TYPES   = ["jewellery", "coins", "bars"];
const VALID_PURITIES    = ["22k", "24k"];

// ─── GET /api/metals/rates ─────────────────────────────────────────────────
const getRates = async (req, res) => {
  try {
    const rates = await getLatestRates();
    return success(res, rates);
  } catch (err) {
    console.error("[metals/rates] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── GET /api/metals/holdings ──────────────────────────────────────────────
const getHoldings = async (req, res) => {
  try {
    const [rates, dayChangePct, result] = await Promise.all([
      getLatestRates(),
      fetchGoldDayChangePct().catch(() => 0),
      pool.query(
        `SELECT id, metal_type, sub_type, label, quantity_grams, purity, notes, created_at, updated_at
         FROM metal_holdings
         WHERE user_id = $1
         ORDER BY metal_type, created_at`,
        [req.user_id]
      ),
    ]);

    const { gold_22k_per_gram, gold_24k_per_gram } = rates;

    const holdings = result.rows.map((h) => {
      const qty  = parseFloat(h.quantity_grams);
      const rate = h.metal_type === "physical_gold" && h.purity === "22k"
        ? gold_22k_per_gram
        : gold_24k_per_gram;
      const current_value = parseFloat((qty * rate).toFixed(2));
      // day_change = current_value - prev_value; prev_value = current_value / (1 + pct)
      const day_change = parseFloat((current_value - current_value / (1 + dayChangePct)).toFixed(2));

      return {
        id:             h.id,
        metal_type:     h.metal_type,
        sub_type:       h.sub_type,
        label:          h.label,
        quantity_grams: qty,
        purity:         h.purity,
        notes:          h.notes,
        current_value,
        day_change,
        created_at:     h.created_at,
        updated_at:     h.updated_at,
      };
    });

    const total_value = parseFloat(
      holdings.reduce((sum, h) => sum + h.current_value, 0).toFixed(2)
    );
    const total_day_pnl = parseFloat(
      holdings.reduce((sum, h) => sum + h.day_change, 0).toFixed(2)
    );

    return success(res, { holdings, total_value, total_day_pnl, rates });
  } catch (err) {
    console.error("[metals/holdings GET] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── POST /api/metals/holdings ─────────────────────────────────────────────
const addHolding = async (req, res) => {
  const { metal_type, sub_type, label, quantity_grams, purity, notes } = req.body;

  if (!metal_type || !VALID_METAL_TYPES.includes(metal_type))
    return fail(res, `metal_type must be one of: ${VALID_METAL_TYPES.join(", ")}`);

  if (metal_type === "physical_gold" && (!sub_type || !VALID_SUB_TYPES.includes(sub_type)))
    return fail(res, `sub_type is required for physical_gold and must be one of: ${VALID_SUB_TYPES.join(", ")}`);

  if (!purity || !VALID_PURITIES.includes(purity))
    return fail(res, `purity must be one of: ${VALID_PURITIES.join(", ")}`);

  if (!label || label.trim().length === 0)
    return fail(res, "label is required");

  const qty = parseFloat(quantity_grams);
  if (isNaN(qty) || qty <= 0)
    return fail(res, "quantity_grams must be a positive number");

  try {
    const result = await pool.query(
      `INSERT INTO metal_holdings (user_id, metal_type, sub_type, label, quantity_grams, purity, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.user_id,
        metal_type,
        metal_type === "physical_gold" ? sub_type : null,
        label.trim(),
        qty,
        purity,
        notes || null,
      ]
    );

    const rates = await getLatestRates();
    const h     = result.rows[0];
    const rate  = h.metal_type === "physical_gold" && h.purity === "22k"
      ? rates.gold_22k_per_gram
      : rates.gold_24k_per_gram;

    return success(res, {
      ...h,
      quantity_grams: parseFloat(h.quantity_grams),
      current_value:  parseFloat((parseFloat(h.quantity_grams) * rate).toFixed(2)),
    }, 201);
  } catch (err) {
    console.error("[metals/holdings POST] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── PUT /api/metals/holdings/:id ──────────────────────────────────────────
const updateHolding = async (req, res) => {
  const { id } = req.params;
  const { metal_type, sub_type, label, quantity_grams, purity, notes } = req.body;

  const ownerCheck = await pool.query(
    `SELECT id FROM metal_holdings WHERE id = $1 AND user_id = $2`,
    [id, req.user_id]
  );
  if (ownerCheck.rows.length === 0)
    return fail(res, "Holding not found", 404);

  if (metal_type && !VALID_METAL_TYPES.includes(metal_type))
    return fail(res, `metal_type must be one of: ${VALID_METAL_TYPES.join(", ")}`);

  if (metal_type === "physical_gold" && sub_type && !VALID_SUB_TYPES.includes(sub_type))
    return fail(res, `sub_type must be one of: ${VALID_SUB_TYPES.join(", ")}`);

  if (purity && !VALID_PURITIES.includes(purity))
    return fail(res, `purity must be one of: ${VALID_PURITIES.join(", ")}`);

  if (quantity_grams !== undefined) {
    const qty = parseFloat(quantity_grams);
    if (isNaN(qty) || qty <= 0)
      return fail(res, "quantity_grams must be a positive number");
  }

  try {
    const result = await pool.query(
      `UPDATE metal_holdings
       SET metal_type     = COALESCE($1, metal_type),
           sub_type       = CASE WHEN $1 = 'physical_gold' THEN $2 ELSE sub_type END,
           label          = COALESCE(NULLIF(TRIM($3), ''), label),
           quantity_grams = COALESCE($4, quantity_grams),
           purity         = COALESCE($5, purity),
           notes          = COALESCE($6, notes),
           updated_at     = NOW()
       WHERE id = $7 AND user_id = $8
       RETURNING *`,
      [
        metal_type || null,
        sub_type   || null,
        label      || null,
        quantity_grams ? parseFloat(quantity_grams) : null,
        purity     || null,
        notes !== undefined ? notes : null,
        id,
        req.user_id,
      ]
    );

    const rates = await getLatestRates();
    const h     = result.rows[0];
    const rate  = h.metal_type === "physical_gold" && h.purity === "22k"
      ? rates.gold_22k_per_gram
      : rates.gold_24k_per_gram;

    return success(res, {
      ...h,
      quantity_grams: parseFloat(h.quantity_grams),
      current_value:  parseFloat((parseFloat(h.quantity_grams) * rate).toFixed(2)),
    });
  } catch (err) {
    console.error("[metals/holdings PUT] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── DELETE /api/metals/holdings/:id ──────────────────────────────────────
const deleteHolding = async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM metal_holdings WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.user_id]
    );

    if (result.rows.length === 0)
      return fail(res, "Holding not found", 404);

    return success(res, { deleted_id: id });
  } catch (err) {
    console.error("[metals/holdings DELETE] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── GET /api/metals/summary ───────────────────────────────────────────────
const getMetalsSummary = async (req, res) => {
  try {
    const [rates, dayChangePct, holdingsResult, cagrResult] = await Promise.all([
      getLatestRates(),
      fetchGoldDayChangePct().catch(() => 0),
      pool.query(
        `SELECT metal_type, quantity_grams, purity FROM metal_holdings WHERE user_id = $1`,
        [req.user_id]
      ),
      pool.query(
        `SELECT symbol,
                multiplier_1y::float8, multiplier_3y::float8, multiplier_5y::float8
         FROM asset_cagr
         WHERE asset_type = 'metal'`
      ),
    ]);

    const { gold_22k_per_gram, gold_24k_per_gram } = rates;

    // Build a map of metal_type → CAGR multipliers
    const cagrMap = {};
    for (const row of cagrResult.rows) {
      cagrMap[row.symbol] = {
        multiplier_1y: row.multiplier_1y,
        multiplier_3y: row.multiplier_3y,
        multiplier_5y: row.multiplier_5y,
      };
    }

    let total_value = 0;
    let total_day_pnl = 0;
    let projected_1y = 0;
    let projected_3y = 0;
    let projected_5y = 0;

    for (const h of holdingsResult.rows) {
      const qty  = parseFloat(h.quantity_grams);
      const rate = h.metal_type === "physical_gold" && h.purity === "22k"
        ? gold_22k_per_gram
        : gold_24k_per_gram;
      const current_value = qty * rate;
      const day_change    = current_value - current_value / (1 + dayChangePct);

      total_value    += current_value;
      total_day_pnl  += day_change;

      const cagr = cagrMap[h.metal_type];
      projected_1y += current_value * (cagr?.multiplier_1y ?? 1.0);
      projected_3y += current_value * (cagr?.multiplier_3y ?? 1.0);
      projected_5y += current_value * (cagr?.multiplier_5y ?? 1.0);
    }

    const has_cagr = holdingsResult.rows.some((h) => !!cagrMap[h.metal_type]);

    return success(res, {
      total_value:    parseFloat(total_value.toFixed(2)),
      total_day_pnl:  parseFloat(total_day_pnl.toFixed(2)),
      projected_1y:   parseFloat(projected_1y.toFixed(2)),
      projected_3y:   parseFloat(projected_3y.toFixed(2)),
      projected_5y:   parseFloat(projected_5y.toFixed(2)),
      has_cagr,
    });
  } catch (err) {
    console.error("[metals/summary GET] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── POST /api/metals/sync-cagr ────────────────────────────────────────────
const syncMetalsCagr = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT metal_type FROM metal_holdings WHERE user_id = $1`,
      [req.user_id]
    );

    const metalTypes = result.rows.map((r) => r.metal_type);

    if (metalTypes.length === 0) {
      return success(res, { message: "No metal holdings found", updated: 0 });
    }

    await recomputeMetalsCagr(metalTypes);

    return success(res, {
      message: "CAGR computed successfully",
      updated: metalTypes.length,
      metal_types: metalTypes,
    });
  } catch (err) {
    console.error("[metals/sync-cagr] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

module.exports = { getRates, getHoldings, addHolding, updateHolding, deleteHolding, getMetalsSummary, syncMetalsCagr };
