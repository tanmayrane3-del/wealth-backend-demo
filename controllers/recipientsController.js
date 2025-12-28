const pool = require("../db");

// Get all recipients for the user
const getRecipients = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT 
        id,
        name,
        type,
        description,
        contact_info,
        is_favorite,
        is_active
      FROM recipients
      WHERE (user_id = $1 OR user_id IS NULL)
        AND is_active = true
      ORDER BY is_favorite DESC, name ASC`,
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

module.exports = {
  getRecipients
};