const pool = require("../db");

// Get all income categories for the user
const getIncomeCategories = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT 
        id,
        name,
        description,
        icon,
        color,
        is_default,
        is_active,
        display_order
      FROM income_categories
      WHERE (user_id = $1 OR user_id IS NULL OR is_default = true)
        AND is_active = true
      ORDER BY display_order ASC, name ASC`,
      [user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows
    });
  } catch (err) {
    console.error("Get income categories error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Get all expense categories for the user
const getExpenseCategories = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT 
        id,
        name,
        description,
        icon,
        color,
        is_default,
        is_active,
        monthly_budget_limit,
        display_order
      FROM expense_categories
      WHERE (user_id = $1 OR user_id IS NULL OR is_default = true)
        AND is_active = true
      ORDER BY display_order ASC, name ASC`,
      [user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows
    });
  } catch (err) {
    console.error("Get expense categories error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

module.exports = {
  getIncomeCategories,
  getExpenseCategories
};
