const pool = require("../db");

// FIXED: Changed to use req.user_id instead of req.body.user_id
const addIncome = async (req, res) => {
  const {
    date, time, amount, currency,
    category_id, source_id, payment_method,
    transaction_reference, notes, tags
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO income (
        user_id, date, time, amount, currency,
        category_id, source_id, payment_method,
        transaction_reference, notes, tags
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11
      ) RETURNING income_id`,
      [
        req.user_id, date, time, amount, currency,  // CHANGED: req.user_id instead of user_id
        category_id, source_id, payment_method,
        transaction_reference, notes, tags
      ]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: { income_id: result.rows[0].income_id }
    });
  } catch (err) {
    console.error("Add income error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Enhanced existing function - now supports date range filtering
const getUserIncome = async (req, res) => {
  const user_id = req.user_id;
  const { start_date, end_date } = req.query; // NEW: Get date range from query params

  try {
    let query = `
      SELECT 
        i.income_id,
        i.date,
        i.time,
        i.amount,
        i.currency,
        ic.name AS category_name,
        ic.description AS category_description,
        s.name AS source_name,
        s.description AS source_description,
        i.payment_method,
        i.transaction_reference,
        i.notes,
        i.tags
      FROM income i
      LEFT JOIN income_categories ic ON i.category_id = ic.id
      LEFT JOIN income_sources s ON i.source_id = s.id
      WHERE i.user_id = $1
    `;

    const params = [user_id];

    // NEW: Add date range filter if provided
    if (start_date && end_date) {
      query += ` AND i.date >= $2 AND i.date <= $3`;
      params.push(start_date, end_date);
    } else if (start_date) {
      query += ` AND i.date >= $2`;
      params.push(start_date);
    } else if (end_date) {
      query += ` AND i.date <= $2`;
      params.push(end_date);
    }

    query += ` ORDER BY i.date DESC, i.time DESC`;

    const result = await pool.query(query, params);

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows
    });
  } catch (err) {
    console.error("Get income error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// NEW: Get single income record by ID
const getIncomeById = async (req, res) => {
  const user_id = req.user_id;
  const { income_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT 
        i.income_id,
        i.user_id,
        i.date,
        i.time,
        i.amount,
        i.currency,
        i.category_id,
        ic.name AS category_name,
        i.source_id,
        s.name AS source_name,
        i.payment_method,
        i.transaction_reference,
        i.notes,
        i.tags,
        i.created_at
      FROM income i
      LEFT JOIN income_categories ic ON i.category_id = ic.id
      LEFT JOIN income_sources s ON i.source_id = s.id
      WHERE i.income_id = $1 AND i.user_id = $2`,
      [income_id, user_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Income record not found"
      });
    }

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Get income by ID error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// NEW: Update income record
const updateIncome = async (req, res) => {
  const user_id = req.user_id;
  const { income_id } = req.params;
  const {
    date, time, amount, currency,
    category_id, source_id, payment_method,
    transaction_reference, notes, tags
  } = req.body;

  try {
    // First verify the income belongs to the user
    const checkResult = await pool.query(
      "SELECT income_id FROM income WHERE income_id = $1 AND user_id = $2",
      [income_id, user_id]
    );

    if (checkResult.rowCount === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Income record not found or unauthorized"
      });
    }

    // Update the record (only update fields that are provided)
    const result = await pool.query(
      `UPDATE income 
       SET date = COALESCE($1, date),
           time = COALESCE($2, time),
           amount = COALESCE($3, amount),
           currency = COALESCE($4, currency),
           category_id = COALESCE($5, category_id),
           source_id = COALESCE($6, source_id),
           payment_method = COALESCE($7, payment_method),
           transaction_reference = COALESCE($8, transaction_reference),
           notes = COALESCE($9, notes),
           tags = COALESCE($10, tags)
       WHERE income_id = $11 AND user_id = $12
       RETURNING income_id`,
      [date, time, amount, currency, category_id, source_id, 
       payment_method, transaction_reference, notes, tags, income_id, user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: {
        income_id: result.rows[0].income_id,
        message: "Income record updated successfully"
      }
    });
  } catch (err) {
    console.error("Update income error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// NEW: Delete income record
const deleteIncome = async (req, res) => {
  const user_id = req.user_id;
  const { income_id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM income WHERE income_id = $1 AND user_id = $2 RETURNING income_id",
      [income_id, user_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Income record not found or unauthorized"
      });
    }

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: {
        income_id: result.rows[0].income_id,
        message: "Income record deleted successfully"
      }
    });
  } catch (err) {
    console.error("Delete income error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// NEW: Get income summary (total) for date range
const getIncomeSummary = async (req, res) => {
  const user_id = req.user_id;
  const { start_date, end_date } = req.query;

  try {
    let query = `
      SELECT 
        COALESCE(SUM(amount), 0) as total_income,
        COUNT(*) as transaction_count,
        currency
      FROM income
      WHERE user_id = $1
    `;

    const params = [user_id];

    if (start_date && end_date) {
      query += ` AND date >= $2 AND date <= $3`;
      params.push(start_date, end_date);
    } else if (start_date) {
      query += ` AND date >= $2`;
      params.push(start_date);
    } else if (end_date) {
      query += ` AND date <= $2`;
      params.push(end_date);
    }

    query += ` GROUP BY currency`;

    const result = await pool.query(query, params);

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows
    });
  } catch (err) {
    console.error("Get income summary error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Export all functions
module.exports = { 
  addIncome, 
  getUserIncome,
  getIncomeById,
  updateIncome,
  deleteIncome,
  getIncomeSummary
};