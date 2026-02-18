const pool = require("../db");

// Get all recipients for the user
const getRecipients = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT
        r.id,
        r.name,
        r.type,
        r.description,
        r.contact_info,
        r.is_favorite,
        r.is_default,
        r.is_global,
        r.is_active,
        CASE
          WHEN r.user_id = $1 AND r.is_global = false AND r.is_default = false
          THEN true
          ELSE false
        END as is_user_specific,
        COALESCE(
          (SELECT COUNT(*) FROM expenses WHERE recipient_id = r.id AND user_id = $1),
          0
        )::integer as transaction_count
      FROM recipients r
      WHERE (r.user_id = $1 OR r.user_id IS NULL OR r.is_default = true)
        AND r.is_active = true
      ORDER BY r.is_favorite DESC, r.name ASC`,
      [user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows
    });
  } catch (err) {
    console.error("Get recipients error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Create a new recipient for the user
const createRecipient = async (req, res) => {
  const user_id = req.user_id;
  const { name, type, description, contact_info, is_favorite } = req.body;

  if (!name) {
    return res.status(400).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: "Name is required"
    });
  }

  try {
    // Check if recipient with same name already exists for this user
    const existingRecipient = await pool.query(
      `SELECT id FROM recipients
       WHERE LOWER(name) = LOWER($1)
       AND (user_id = $2 OR (user_id IS NULL AND is_global = true))
       AND is_active = true`,
      [name, user_id]
    );

    if (existingRecipient.rows.length > 0) {
      return res.status(409).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Recipient with this name already exists"
      });
    }

    const result = await pool.query(
      `INSERT INTO recipients (
        user_id, name, type, description, contact_info, is_favorite,
        is_default, is_global, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, false, false, true)
      RETURNING id, user_id, name, type, description, contact_info,
                is_favorite, is_default, is_global, is_active, created_at`,
      [user_id, name, type || null, description || null, contact_info || null, is_favorite || false]
    );

    res.status(201).json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Create recipient error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Update a recipient (only if owned by user)
const updateRecipient = async (req, res) => {
  const user_id = req.user_id;
  const { id } = req.params;
  const { name, type, description, contact_info, is_favorite, is_active } = req.body;

  try {
    // Check if recipient exists
    const recipientCheck = await pool.query(
      `SELECT id, is_default, is_global, user_id FROM recipients WHERE id = $1`,
      [id]
    );

    if (recipientCheck.rows.length === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Recipient not found"
      });
    }

    const recipient = recipientCheck.rows[0];

    // Prevent updating default/global recipients
    if (recipient.is_default || recipient.is_global) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot modify default or global recipients"
      });
    }

    // Check ownership
    if (recipient.user_id !== user_id) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "You can only update your own recipients"
      });
    }

    // If name is being changed, check for duplicates
    if (name) {
      const duplicateCheck = await pool.query(
        `SELECT id FROM recipients
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
          reason: "Recipient with this name already exists"
        });
      }
    }

    const result = await pool.query(
      `UPDATE recipients
       SET name = COALESCE($1, name),
           type = COALESCE($2, type),
           description = COALESCE($3, description),
           contact_info = COALESCE($4, contact_info),
           is_favorite = COALESCE($5, is_favorite),
           is_active = COALESCE($6, is_active),
           updated_at = NOW()
       WHERE id = $7 AND user_id = $8
       RETURNING id, user_id, name, type, description, contact_info,
                 is_favorite, is_default, is_global, is_active, updated_at`,
      [name, type, description, contact_info, is_favorite, is_active, id, user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Update recipient error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Delete a recipient (only if owned by user and has no transactions)
const deleteRecipient = async (req, res) => {
  const user_id = req.user_id;
  const { id } = req.params;

  try {
    // Check if recipient exists
    const recipientCheck = await pool.query(
      `SELECT id, is_default, is_global, user_id FROM recipients WHERE id = $1`,
      [id]
    );

    if (recipientCheck.rows.length === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Recipient not found"
      });
    }

    const recipient = recipientCheck.rows[0];

    // Prevent deleting default/global recipients
    if (recipient.is_default || recipient.is_global) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot delete default or global recipients"
      });
    }

    // Check ownership
    if (recipient.user_id !== user_id) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "You can only delete your own recipients"
      });
    }

    // Check if recipient has transactions
    const transactionCheck = await pool.query(
      `SELECT COUNT(*) as count FROM expenses WHERE recipient_id = $1 AND user_id = $2`,
      [id, user_id]
    );

    if (parseInt(transactionCheck.rows[0].count) > 0) {
      return res.status(409).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot delete recipient with existing transactions"
      });
    }

    // Soft delete the recipient
    await pool.query(
      `UPDATE recipients SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      message: "Recipient deleted successfully"
    });
  } catch (err) {
    console.error("Delete recipient error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

module.exports = {
  getRecipients,
  createRecipient,
  updateRecipient,
  deleteRecipient
};
