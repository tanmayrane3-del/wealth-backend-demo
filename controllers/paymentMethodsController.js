const pool = require("../db");

// Get all unique payment methods used by the user
const getPaymentMethods = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT DISTINCT payment_method
      FROM (
        SELECT payment_method FROM income WHERE user_id = $1 AND payment_method IS NOT NULL
        UNION
        SELECT payment_method FROM expenses WHERE user_id = $1 AND payment_method IS NOT NULL
      ) AS combined_methods
      ORDER BY payment_method ASC`,
      [user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows.map(row => row.payment_method)
    });
  } catch (err) {
    console.error("Get payment methods error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

module.exports = {
  getPaymentMethods
};