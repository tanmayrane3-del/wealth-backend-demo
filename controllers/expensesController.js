const pool = require("../db");

// Existing function - kept as is
const addExpense = async (req, res) => {
  const {
    date, time, amount, currency,
    category_id, recipient_id, payment_method,
    transaction_reference, notes, tags
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO expenses (
        user_id, date, time, amount, currency,
        category_id, recipient_id, payment_method,
        transaction_reference, notes, tags
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11
      ) RETURNING expense_id`,
      [
        req.user_id, date, time, amount, currency,
        category_id, recipient_id, payment_method,
        transaction_reference, notes, tags
      ]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: { expense_id: result.rows[0].expense_id }
    });
  } catch (err) {
    console.error("Add expense error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Enhanced existing function - now supports date range filtering
const getUserExpenses = async (req, res) => {
  const user_id = req.user_id;
  const { start_date, end_date } = req.query; // NEW: Get date range from query params

  try {
    let query = `
      SELECT 
        e.expense_id,
        e.date,
        e.time,
        e.amount,
        e.currency,
        ec.name AS category_name,
        r.name AS recipient_name,
        e.payment_method,
        e.transaction_reference,
        e.notes,
        e.tags
      FROM expenses e
      LEFT JOIN expense_categories ec ON e.category_id = ec.id
      LEFT JOIN recipients r ON e.recipient_id = r.id
      WHERE e.user_id = $1
    `;

    const params = [user_id];

    // NEW: Add date range filter if provided
    if (start_date && end_date) {
      query += ` AND e.date >= $2 AND e.date <= $3`;
      params.push(start_date, end_date);
    } else if (start_date) {
      query += ` AND e.date >= $2`;
      params.push(start_date);
    } else if (end_date) {
      query += ` AND e.date <= $2`;
      params.push(end_date);
    }

    query += ` ORDER BY e.date DESC, e.time DESC`;

    const result = await pool.query(query, params);

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows
    });
  } catch (err) {
    console.error("Get expenses error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// NEW: Get single expense record by ID
const getExpenseById = async (req, res) => {
  const user_id = req.user_id;
  const { expense_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT 
        e.expense_id,
        e.user_id,
        e.date,
        e.time,
        e.amount,
        e.currency,
        e.category_id,
        ec.name AS category_name,
        e.recipient_id,
        r.name AS recipient_name,
        e.payment_method,
        e.transaction_reference,
        e.notes,
        e.tags,
        e.created_at
      FROM expenses e
      LEFT JOIN expense_categories ec ON e.category_id = ec.id
      LEFT JOIN recipients r ON e.recipient_id = r.id
      WHERE e.expense_id = $1 AND e.user_id = $2`,
      [expense_id, user_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Expense record not found"
      });
    }

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Get expense by ID error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// NEW: Update expense record
const updateExpense = async (req, res) => {
  const user_id = req.user_id;
  const { expense_id } = req.params;
  const {
    date, time, amount, currency,
    category_id, recipient_id, payment_method,
    transaction_reference, notes, tags
  } = req.body;

  try {
    // First verify the expense belongs to the user
    const checkResult = await pool.query(
      "SELECT expense_id FROM expenses WHERE expense_id = $1 AND user_id = $2",
      [expense_id, user_id]
    );

    if (checkResult.rowCount === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Expense record not found or unauthorized"
      });
    }

    // Update the record
    const result = await pool.query(
      `UPDATE expenses 
       SET date = COALESCE($1, date),
           time = COALESCE($2, time),
           amount = COALESCE($3, amount),
           currency = COALESCE($4, currency),
           category_id = COALESCE($5, category_id),
           recipient_id = COALESCE($6, recipient_id),
           payment_method = COALESCE($7, payment_method),
           transaction_reference = COALESCE($8, transaction_reference),
           notes = COALESCE($9, notes),
           tags = COALESCE($10, tags)
       WHERE expense_id = $11 AND user_id = $12
       RETURNING expense_id`,
      [date, time, amount, currency, category_id, recipient_id, 
       payment_method, transaction_reference, notes, tags, expense_id, user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: {
        expense_id: result.rows[0].expense_id,
        message: "Expense record updated successfully"
      }
    });
  } catch (err) {
    console.error("Update expense error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// NEW: Delete expense record
const deleteExpense = async (req, res) => {
  const user_id = req.user_id;
  const { expense_id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM expenses WHERE expense_id = $1 AND user_id = $2 RETURNING expense_id",
      [expense_id, user_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Expense record not found or unauthorized"
      });
    }

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: {
        expense_id: result.rows[0].expense_id,
        message: "Expense record deleted successfully"
      }
    });
  } catch (err) {
    console.error("Delete expense error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// NEW: Get expense summary (total) for date range
const getExpenseSummary = async (req, res) => {
  const user_id = req.user_id;
  const { start_date, end_date } = req.query;

  try {
    let query = `
      SELECT 
        COALESCE(SUM(amount), 0) as total_expenses,
        COUNT(*) as transaction_count,
        currency
      FROM expenses
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
    console.error("Get expense summary error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Export all functions
module.exports = { 
  addExpense, 
  getUserExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
  getExpenseSummary
};