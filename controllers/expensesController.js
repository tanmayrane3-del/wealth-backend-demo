const pool = require("../db");

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

const getUserExpenses = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
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
       JOIN expense_categories ec ON e.category_id = ec.id
       JOIN recipients r          ON e.recipient_id = r.id
       WHERE e.user_id = $1
       ORDER BY e.date DESC, e.time DESC`,
      [req.user_id]
    );

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

module.exports = { addExpense, getUserExpenses };