const pool = require("../db");

// Get all income sources for the user
const getIncomeSources = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT 
        id,
        name,
        description,
        type,
        contact_info,
        is_active
      FROM income_sources
      WHERE (user_id = $1 OR user_id IS NULL)
        AND is_active = true
      ORDER BY name ASC`,
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

module.exports = {
  getIncomeSources
};