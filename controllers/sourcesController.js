const pool = require("../db");

// Get all income sources for the user
const getIncomeSources = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT
        s.id,
        s.name,
        s.description,
        s.type,
        s.contact_info,
        s.is_default,
        s.is_global,
        s.is_active,
        CASE
          WHEN s.user_id = $1 AND s.is_global = false AND s.is_default = false
          THEN true
          ELSE false
        END as is_user_specific,
        COALESCE(
          (SELECT COUNT(*) FROM income WHERE source_id = s.id AND user_id = $1),
          0
        )::integer as transaction_count
      FROM income_sources s
      WHERE (s.user_id = $1 OR s.user_id IS NULL OR s.is_default = true)
        AND s.is_active = true
      ORDER BY s.name ASC`,
      [user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows
    });
  } catch (err) {
    console.error("Get income sources error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Create a new income source for the user
const createIncomeSource = async (req, res) => {
  const user_id = req.user_id;
  const { name, description, type, contact_info } = req.body;

  if (!name) {
    return res.status(400).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: "Name is required"
    });
  }

  try {
    // Check if source with same name already exists for this user
    const existingSource = await pool.query(
      `SELECT id FROM income_sources
       WHERE LOWER(name) = LOWER($1)
       AND (user_id = $2 OR (user_id IS NULL AND is_global = true))
       AND is_active = true`,
      [name, user_id]
    );

    if (existingSource.rows.length > 0) {
      return res.status(409).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Income source with this name already exists"
      });
    }

    const result = await pool.query(
      `INSERT INTO income_sources (
        user_id, name, description, type, contact_info,
        is_default, is_global, is_active
      ) VALUES ($1, $2, $3, $4, $5, false, false, true)
      RETURNING id, user_id, name, description, type, contact_info,
                is_default, is_global, is_active, created_at`,
      [user_id, name, description || null, type || null, contact_info || null]
    );

    res.status(201).json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Create income source error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Update an income source (only if owned by user)
const updateIncomeSource = async (req, res) => {
  const user_id = req.user_id;
  const { id } = req.params;
  const { name, description, type, contact_info, is_active } = req.body;

  try {
    // Check if source exists
    const sourceCheck = await pool.query(
      `SELECT id, is_default, is_global, user_id FROM income_sources WHERE id = $1`,
      [id]
    );

    if (sourceCheck.rows.length === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Income source not found"
      });
    }

    const source = sourceCheck.rows[0];

    // Prevent updating default/global sources
    if (source.is_default || source.is_global) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot modify default or global income sources"
      });
    }

    // Check ownership
    if (source.user_id !== user_id) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "You can only update your own income sources"
      });
    }

    // If name is being changed, check for duplicates
    if (name) {
      const duplicateCheck = await pool.query(
        `SELECT id FROM income_sources
         WHERE LOWER(name) = LOWER($1)
         AND id != $2
         AND (user_id = $3 OR (user_id IS NULL AND is_global = true))
         AND is_active = true`,
        [name, id, user_id]
      );

      if (duplicateCheck.rows.length > 0) {
        return res.status(409).json({
          status: "fail",
          timestamp: new Date().toISOString(),
          reason: "Income source with this name already exists"
        });
      }
    }

    const result = await pool.query(
      `UPDATE income_sources
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           type = COALESCE($3, type),
           contact_info = COALESCE($4, contact_info),
           is_active = COALESCE($5, is_active),
           updated_at = NOW()
       WHERE id = $6 AND user_id = $7
       RETURNING id, user_id, name, description, type, contact_info,
                 is_default, is_global, is_active, updated_at`,
      [name, description, type, contact_info, is_active, id, user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Update income source error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Delete an income source (only if owned by user and has no transactions)
const deleteIncomeSource = async (req, res) => {
  const user_id = req.user_id;
  const { id } = req.params;

  try {
    // Check if source exists
    const sourceCheck = await pool.query(
      `SELECT id, is_default, is_global, user_id FROM income_sources WHERE id = $1`,
      [id]
    );

    if (sourceCheck.rows.length === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Income source not found"
      });
    }

    const source = sourceCheck.rows[0];

    // Prevent deleting default/global sources
    if (source.is_default || source.is_global) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot delete default or global income sources"
      });
    }

    // Check ownership
    if (source.user_id !== user_id) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "You can only delete your own income sources"
      });
    }

    // Check if source has transactions
    const transactionCheck = await pool.query(
      `SELECT COUNT(*) as count FROM income WHERE source_id = $1 AND user_id = $2`,
      [id, user_id]
    );

    if (parseInt(transactionCheck.rows[0].count) > 0) {
      return res.status(409).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot delete income source with existing transactions"
      });
    }

    // Soft delete the source
    await pool.query(
      `UPDATE income_sources SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      message: "Income source deleted successfully"
    });
  } catch (err) {
    console.error("Delete income source error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

module.exports = {
  getIncomeSources,
  createIncomeSource,
  updateIncomeSource,
  deleteIncomeSource
};
