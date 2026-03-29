const pool = require("../db");
const { success, fail } = require("../utils/respond");

const VALID_ASSET_TYPES = ["real_estate", "vehicle"];

// ─── GET /api/physical-assets ─────────────────────────────────────────────
const getAssets = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, asset_type, label, purchase_price::float8, purchase_date,
              current_market_value::float8, market_value_last_updated,
              depreciation_rate_pct::float8, notes, is_active, created_at, updated_at
       FROM physical_assets
       WHERE user_id = $1 AND is_active = true
       ORDER BY created_at DESC`,
      [req.user_id]
    );
    return success(res, { assets: result.rows });
  } catch (err) {
    console.error("[physical-assets GET] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── GET /api/physical-assets/summary ────────────────────────────────────
const getSummary = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         pa.id,
         pa.asset_type,
         pa.label,
         pa.purchase_price::float8,
         pa.purchase_date,
         pa.current_market_value::float8,
         pa.market_value_last_updated,
         pa.depreciation_rate_pct::float8,
         pa.notes,
         pa.is_active,
         pa.created_at,
         pa.updated_at,
         CASE WHEN l.id IS NOT NULL THEN true ELSE false END AS has_active_loan,
         l.id AS linked_loan_id
       FROM physical_assets pa
       LEFT JOIN liabilities l
         ON l.physical_asset_id = pa.id
         AND l.status = 'active'
         AND l.is_deleted = false
       WHERE pa.user_id = $1 AND pa.is_active = true
       ORDER BY pa.created_at DESC`,
      [req.user_id]
    );

    const assets = result.rows;
    const today = new Date();

    // Compute WDV for each asset (same formula as netWorthController)
    let total_current_value = 0;
    let proj_1y = 0, proj_3y = 0, proj_5y = 0;

    for (const a of assets) {
      let currentVal;
      if (a.asset_type === "real_estate") {
        currentVal = parseFloat(a.current_market_value || a.purchase_price);
        // Real estate: held flat (no CAGR data yet)
        proj_1y += currentVal;
        proj_3y += currentVal;
        proj_5y += currentVal;
      } else {
        // Vehicle: -15% WDV per year (compound)
        const yearsHeld =
          (today - new Date(a.purchase_date)) / (365.25 * 24 * 60 * 60 * 1000);
        currentVal = parseFloat(a.purchase_price) * Math.pow(0.85, yearsHeld);
        proj_1y += currentVal * Math.pow(0.85, 1);
        proj_3y += currentVal * Math.pow(0.85, 3);
        proj_5y += currentVal * Math.pow(0.85, 5);
      }
      total_current_value += currentVal;
    }

    return success(res, {
      total_current_value: parseFloat(total_current_value.toFixed(2)),
      proj_1y:             parseFloat(proj_1y.toFixed(2)),
      proj_3y:             parseFloat(proj_3y.toFixed(2)),
      proj_5y:             parseFloat(proj_5y.toFixed(2)),
      assets,
    });
  } catch (err) {
    console.error("[physical-assets/summary GET] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── POST /api/physical-assets ───────────────────────────────────────────
const createAsset = async (req, res) => {
  const {
    asset_type, label, purchase_price, purchase_date,
    current_market_value, depreciation_rate_pct, notes,
  } = req.body;

  if (!asset_type || !VALID_ASSET_TYPES.includes(asset_type))
    return fail(res, `asset_type must be one of: ${VALID_ASSET_TYPES.join(", ")}`);

  if (!label || label.trim().length === 0)
    return fail(res, "label is required");

  const price = parseFloat(purchase_price);
  if (isNaN(price) || price <= 0)
    return fail(res, "purchase_price must be a positive number");

  if (!purchase_date)
    return fail(res, "purchase_date is required (yyyy-MM-dd)");

  if (asset_type === "real_estate") {
    if (current_market_value === undefined || current_market_value === null)
      return fail(res, "current_market_value is required for real_estate assets");
    const cmv = parseFloat(current_market_value);
    if (isNaN(cmv) || cmv < 0)
      return fail(res, "current_market_value must be a non-negative number");
  }

  let deprRate = null;
  if (asset_type === "vehicle") {
    deprRate = depreciation_rate_pct !== undefined
      ? parseFloat(depreciation_rate_pct)
      : 10;
    if (isNaN(deprRate) || deprRate < 0 || deprRate > 100)
      return fail(res, "depreciation_rate_pct must be between 0 and 100");
  }

  try {
    const result = await pool.query(
      `INSERT INTO physical_assets
         (user_id, asset_type, label, purchase_price, purchase_date,
          current_market_value, market_value_last_updated, depreciation_rate_pct, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, asset_type, label, purchase_price::float8, purchase_date,
                 current_market_value::float8, market_value_last_updated,
                 depreciation_rate_pct::float8, notes, is_active, created_at, updated_at`,
      [
        req.user_id,
        asset_type,
        label.trim(),
        price,
        purchase_date,
        asset_type === "real_estate" ? parseFloat(current_market_value) : null,
        asset_type === "real_estate" ? new Date() : null,
        deprRate,
        notes || null,
      ]
    );

    return success(res, result.rows[0], 201);
  } catch (err) {
    console.error("[physical-assets POST] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── PUT /api/physical-assets/:id ────────────────────────────────────────
const updateAsset = async (req, res) => {
  const { id } = req.params;
  const {
    asset_type, label, purchase_price, purchase_date,
    current_market_value, depreciation_rate_pct, notes,
  } = req.body;

  try {
    const ownerCheck = await pool.query(
      `SELECT id, asset_type FROM physical_assets WHERE id = $1 AND user_id = $2 AND is_active = true`,
      [id, req.user_id]
    );
    if (ownerCheck.rows.length === 0)
      return fail(res, "Asset not found", 404);

    if (asset_type && !VALID_ASSET_TYPES.includes(asset_type))
      return fail(res, `asset_type must be one of: ${VALID_ASSET_TYPES.join(", ")}`);

    if (purchase_price !== undefined) {
      const price = parseFloat(purchase_price);
      if (isNaN(price) || price <= 0)
        return fail(res, "purchase_price must be a positive number");
    }

    if (depreciation_rate_pct !== undefined) {
      const dr = parseFloat(depreciation_rate_pct);
      if (isNaN(dr) || dr < 0 || dr > 100)
        return fail(res, "depreciation_rate_pct must be between 0 and 100");
    }

    // If updating current_market_value for a real_estate asset, also update last_updated timestamp
    const marketValueUpdated = current_market_value !== undefined && current_market_value !== null;

    const result = await pool.query(
      `UPDATE physical_assets
       SET asset_type                = COALESCE($1, asset_type),
           label                    = COALESCE(NULLIF(TRIM($2), ''), label),
           purchase_price           = COALESCE($3, purchase_price),
           purchase_date            = COALESCE($4, purchase_date),
           current_market_value     = COALESCE($5, current_market_value),
           market_value_last_updated = CASE WHEN $5 IS NOT NULL THEN NOW() ELSE market_value_last_updated END,
           depreciation_rate_pct    = COALESCE($6, depreciation_rate_pct),
           notes                    = COALESCE($7, notes),
           updated_at               = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING id, asset_type, label, purchase_price::float8, purchase_date,
                 current_market_value::float8, market_value_last_updated,
                 depreciation_rate_pct::float8, notes, is_active, created_at, updated_at`,
      [
        asset_type || null,
        label || null,
        purchase_price !== undefined ? parseFloat(purchase_price) : null,
        purchase_date || null,
        marketValueUpdated ? parseFloat(current_market_value) : null,
        depreciation_rate_pct !== undefined ? parseFloat(depreciation_rate_pct) : null,
        notes !== undefined ? notes : null,
        id,
        req.user_id,
      ]
    );

    return success(res, result.rows[0]);
  } catch (err) {
    console.error("[physical-assets PUT] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── DELETE /api/physical-assets/:id ─────────────────────────────────────
const deleteAsset = async (req, res) => {
  const { id } = req.params;

  try {
    const ownerCheck = await pool.query(
      `SELECT id FROM physical_assets WHERE id = $1 AND user_id = $2 AND is_active = true`,
      [id, req.user_id]
    );
    if (ownerCheck.rows.length === 0)
      return fail(res, "Asset not found", 404);

    // Block delete if any active liability references this asset
    const linked = await pool.query(
      `SELECT id FROM liabilities
       WHERE physical_asset_id = $1 AND status = 'active' AND is_deleted = false`,
      [id]
    );
    if (linked.rows.length > 0)
      return fail(res, "Cannot delete asset with an active loan linked to it", 400);

    await pool.query(
      `UPDATE physical_assets SET is_active = false, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
      [id, req.user_id]
    );

    return success(res, { deleted_id: id });
  } catch (err) {
    console.error("[physical-assets DELETE] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

module.exports = { getAssets, getSummary, createAsset, updateAsset, deleteAsset };
