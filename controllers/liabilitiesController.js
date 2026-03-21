const pool = require("../db");
const { success, fail } = require("../utils/respond");

const VALID_LOAN_TYPES    = ["home", "car", "personal", "education", "business", "other"];
const VALID_INTEREST_TYPES = ["fixed", "floating"];
const VALID_STATUSES      = ["active", "closed", "foreclosed"];

// ─── GET /api/liabilities ─────────────────────────────────────────────────
const getLiabilities = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         l.id, l.loan_type, l.lender_name, l.loan_account_number,
         l.interest_type, l.interest_rate::float8,
         l.original_amount::float8, l.outstanding_principal::float8,
         l.emi_amount::float8, l.emi_due_day,
         l.start_date, l.tenure_months,
         l.physical_asset_id, l.status, l.notes,
         l.created_at, l.updated_at,
         pa.label AS asset_label,
         pa.asset_type AS asset_type
       FROM liabilities l
       LEFT JOIN physical_assets pa ON pa.id = l.physical_asset_id
       WHERE l.user_id = $1 AND l.is_deleted = false
       ORDER BY l.created_at DESC`,
      [req.user_id]
    );
    return success(res, { liabilities: result.rows });
  } catch (err) {
    console.error("[liabilities GET] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── GET /api/liabilities/summary ────────────────────────────────────────
const getSummary = async (req, res) => {
  try {
    const [listResult, statsResult] = await Promise.all([
      pool.query(
        `SELECT
           l.id, l.loan_type, l.lender_name, l.loan_account_number,
           l.interest_type, l.interest_rate::float8,
           l.original_amount::float8, l.outstanding_principal::float8,
           l.emi_amount::float8, l.emi_due_day,
           l.start_date, l.tenure_months,
           l.physical_asset_id, l.status, l.notes,
           l.created_at, l.updated_at,
           pa.label AS asset_label,
           pa.asset_type AS asset_type
         FROM liabilities l
         LEFT JOIN physical_assets pa ON pa.id = l.physical_asset_id
         WHERE l.user_id = $1 AND l.is_deleted = false
         ORDER BY l.created_at DESC`,
        [req.user_id]
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'active' THEN outstanding_principal ELSE 0 END), 0)::float8 AS total_outstanding,
           COALESCE(SUM(CASE WHEN status = 'active' THEN emi_amount ELSE 0 END), 0)::float8 AS total_emi,
           COUNT(CASE WHEN status = 'active' THEN 1 END)::int AS active_count
         FROM liabilities
         WHERE user_id = $1 AND is_deleted = false`,
        [req.user_id]
      ),
    ]);

    const { total_outstanding, total_emi, active_count } = statsResult.rows[0];

    return success(res, {
      total_outstanding,
      total_emi,
      active_count,
      liabilities: listResult.rows,
    });
  } catch (err) {
    console.error("[liabilities/summary GET] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── GET /api/liabilities/:id ─────────────────────────────────────────────
const getLiabilityById = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT
         l.id, l.loan_type, l.lender_name, l.loan_account_number,
         l.interest_type, l.interest_rate::float8,
         l.original_amount::float8, l.outstanding_principal::float8,
         l.emi_amount::float8, l.emi_due_day,
         l.start_date, l.tenure_months,
         l.physical_asset_id, l.status, l.notes,
         l.created_at, l.updated_at,
         pa.label AS asset_label,
         pa.asset_type AS asset_type
       FROM liabilities l
       LEFT JOIN physical_assets pa ON pa.id = l.physical_asset_id
       WHERE l.id = $1 AND l.user_id = $2 AND l.is_deleted = false`,
      [id, req.user_id]
    );

    if (result.rows.length === 0)
      return fail(res, "Liability not found", 404);

    return success(res, result.rows[0]);
  } catch (err) {
    console.error("[liabilities/:id GET] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── POST /api/liabilities ────────────────────────────────────────────────
const createLiability = async (req, res) => {
  const {
    loan_type, lender_name, loan_account_number,
    interest_type, interest_rate, original_amount,
    outstanding_principal, emi_amount, emi_due_day,
    start_date, tenure_months, physical_asset_id, notes,
  } = req.body;

  if (!loan_type || !VALID_LOAN_TYPES.includes(loan_type))
    return fail(res, `loan_type must be one of: ${VALID_LOAN_TYPES.join(", ")}`);

  if (!lender_name || lender_name.trim().length === 0)
    return fail(res, "lender_name is required");

  if (!interest_type || !VALID_INTEREST_TYPES.includes(interest_type))
    return fail(res, `interest_type must be one of: ${VALID_INTEREST_TYPES.join(", ")}`);

  const rate = parseFloat(interest_rate);
  if (isNaN(rate) || rate <= 0)
    return fail(res, "interest_rate must be a positive number");

  const origAmt = parseFloat(original_amount);
  if (isNaN(origAmt) || origAmt <= 0)
    return fail(res, "original_amount must be a positive number");

  const outstanding = parseFloat(outstanding_principal);
  if (isNaN(outstanding) || outstanding < 0)
    return fail(res, "outstanding_principal must be a non-negative number");

  const emi = parseFloat(emi_amount);
  if (isNaN(emi) || emi <= 0)
    return fail(res, "emi_amount must be a positive number");

  if (!start_date)
    return fail(res, "start_date is required (yyyy-MM-dd)");

  const tenure = parseInt(tenure_months);
  if (isNaN(tenure) || tenure <= 0)
    return fail(res, "tenure_months must be a positive integer");

  if (emi_due_day !== undefined && emi_due_day !== null) {
    const day = parseInt(emi_due_day);
    if (isNaN(day) || day < 1 || day > 31)
      return fail(res, "emi_due_day must be between 1 and 31");
  }

  // Validate physical_asset_id belongs to user if provided
  if (physical_asset_id) {
    const assetCheck = await pool.query(
      `SELECT id FROM physical_assets WHERE id = $1 AND user_id = $2 AND is_active = true`,
      [physical_asset_id, req.user_id]
    );
    if (assetCheck.rows.length === 0)
      return fail(res, "physical_asset_id not found or not owned by user", 400);
  }

  try {
    const result = await pool.query(
      `INSERT INTO liabilities
         (user_id, loan_type, lender_name, loan_account_number,
          interest_type, interest_rate, original_amount, outstanding_principal,
          emi_amount, emi_due_day, start_date, tenure_months, physical_asset_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, loan_type, lender_name, loan_account_number,
                 interest_type, interest_rate::float8, original_amount::float8,
                 outstanding_principal::float8, emi_amount::float8, emi_due_day,
                 start_date, tenure_months, physical_asset_id, status, notes,
                 created_at, updated_at`,
      [
        req.user_id, loan_type, lender_name.trim(),
        loan_account_number || null, interest_type, rate, origAmt,
        outstanding, emi, emi_due_day || null, start_date, tenure,
        physical_asset_id || null, notes || null,
      ]
    );
    return success(res, result.rows[0], 201);
  } catch (err) {
    console.error("[liabilities POST] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── PUT /api/liabilities/:id ─────────────────────────────────────────────
const updateLiability = async (req, res) => {
  const { id } = req.params;
  const {
    loan_type, lender_name, loan_account_number,
    interest_type, interest_rate, original_amount,
    outstanding_principal, emi_amount, emi_due_day,
    start_date, tenure_months, physical_asset_id, status, notes,
  } = req.body;

  try {
    const ownerCheck = await pool.query(
      `SELECT id FROM liabilities WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
      [id, req.user_id]
    );
    if (ownerCheck.rows.length === 0)
      return fail(res, "Liability not found", 404);

    if (loan_type && !VALID_LOAN_TYPES.includes(loan_type))
      return fail(res, `loan_type must be one of: ${VALID_LOAN_TYPES.join(", ")}`);

    if (interest_type && !VALID_INTEREST_TYPES.includes(interest_type))
      return fail(res, `interest_type must be one of: ${VALID_INTEREST_TYPES.join(", ")}`);

    if (status && !VALID_STATUSES.includes(status))
      return fail(res, `status must be one of: ${VALID_STATUSES.join(", ")}`);

    if (emi_due_day !== undefined && emi_due_day !== null) {
      const day = parseInt(emi_due_day);
      if (isNaN(day) || day < 1 || day > 31)
        return fail(res, "emi_due_day must be between 1 and 31");
    }

    if (physical_asset_id) {
      const assetCheck = await pool.query(
        `SELECT id FROM physical_assets WHERE id = $1 AND user_id = $2 AND is_active = true`,
        [physical_asset_id, req.user_id]
      );
      if (assetCheck.rows.length === 0)
        return fail(res, "physical_asset_id not found or not owned by user", 400);
    }

    const result = await pool.query(
      `UPDATE liabilities
       SET loan_type              = COALESCE($1,  loan_type),
           lender_name            = COALESCE(NULLIF(TRIM($2), ''), lender_name),
           loan_account_number    = COALESCE($3,  loan_account_number),
           interest_type          = COALESCE($4,  interest_type),
           interest_rate          = COALESCE($5,  interest_rate),
           original_amount        = COALESCE($6,  original_amount),
           outstanding_principal  = COALESCE($7,  outstanding_principal),
           emi_amount             = COALESCE($8,  emi_amount),
           emi_due_day            = COALESCE($9,  emi_due_day),
           start_date             = COALESCE($10, start_date),
           tenure_months          = COALESCE($11, tenure_months),
           physical_asset_id      = COALESCE($12, physical_asset_id),
           status                 = COALESCE($13, status),
           notes                  = COALESCE($14, notes),
           updated_at             = NOW()
       WHERE id = $15 AND user_id = $16
       RETURNING id, loan_type, lender_name, loan_account_number,
                 interest_type, interest_rate::float8, original_amount::float8,
                 outstanding_principal::float8, emi_amount::float8, emi_due_day,
                 start_date, tenure_months, physical_asset_id, status, notes,
                 created_at, updated_at`,
      [
        loan_type || null,
        lender_name || null,
        loan_account_number !== undefined ? loan_account_number : null,
        interest_type || null,
        interest_rate !== undefined ? parseFloat(interest_rate) : null,
        original_amount !== undefined ? parseFloat(original_amount) : null,
        outstanding_principal !== undefined ? parseFloat(outstanding_principal) : null,
        emi_amount !== undefined ? parseFloat(emi_amount) : null,
        emi_due_day !== undefined ? (emi_due_day || null) : null,
        start_date || null,
        tenure_months !== undefined ? parseInt(tenure_months) : null,
        physical_asset_id !== undefined ? (physical_asset_id || null) : null,
        status || null,
        notes !== undefined ? notes : null,
        id,
        req.user_id,
      ]
    );

    return success(res, result.rows[0]);
  } catch (err) {
    console.error("[liabilities PUT] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ─── DELETE /api/liabilities/:id ──────────────────────────────────────────
const deleteLiability = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE liabilities
       SET is_deleted = true, deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND is_deleted = false
       RETURNING id`,
      [id, req.user_id]
    );

    if (result.rows.length === 0)
      return fail(res, "Liability not found", 404);

    return success(res, { deleted_id: id });
  } catch (err) {
    console.error("[liabilities DELETE] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

module.exports = {
  getLiabilities, getSummary, getLiabilityById,
  createLiability, updateLiability, deleteLiability,
};
