const pool = require("../db");

const addIncome = async (req, res) => {
  const {
    user_id, date, time, amount, currency,
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
        user_id, date, time, amount, currency,
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

// ✅ NEW FUNCTION: Fetch income details for a user
const getUserIncome = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT 
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
       JOIN income_categories ic ON i.category_id = ic.id
       JOIN income_sources s     ON i.source_id   = s.id
       WHERE i.user_id = $1
       ORDER BY i.date DESC, i.time DESC`,
      [user_id]
    );

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

module.exports = { addIncome, getUserIncome };