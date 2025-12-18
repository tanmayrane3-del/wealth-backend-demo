const pool = require("../db");

const validateSession = async (req, res, next) => {
  // Prefer header for GET requests, fallback to body
  const session_token =
    req.headers["x-session-token"] || (req.body && req.body.session_token);

  if (!session_token) {
    return res.status(401).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: "Missing session token"
    });
  }

  try {
    const result = await pool.query(
      `SELECT user_id 
      FROM user_sessions 
      WHERE session_token = $1 
      AND is_active = true 
      AND expires_at > NOW()`,
  [session_token]
);


    if (result.rows.length === 0) {
      return res.status(401).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Invalid or expired session"
      });
    }

    // Attach user_id to request for controllers
    req.user_id = result.rows[0].user_id;

    // Continue to the next middleware/controller
    next();
  } catch (err) {
    console.error("Session validation error:", err);
    return res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

module.exports = validateSession;