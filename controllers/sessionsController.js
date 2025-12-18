const pool = require("../db");

// 🔑 Login (create session)
const login = async (req, res) => {
  const { user_id, ip_address, user_agent } = req.body;

  try {
    const result = await pool.query(
      "SELECT create_session($1, $2, $3)",
      [user_id, ip_address, user_agent]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: { session_token: result.rows[0].create_session }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// ✅ Validate session
const validateSession = async (req, res) => {
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
      "SELECT validate_session($1)",
      [session_token]
    );

    const user_id = result.rows[0].validate_session;

    if (user_id) {
      // Attach user_id for downstream controllers
      req.user_id = user_id;

      res.json({
        status: "success",
        timestamp: new Date().toISOString(),
        data: { user_id }
      });
    } else {
      res.status(401).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Invalid or expired session"
      });
    }
  } catch (err) {
    console.error("Validate session error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// 🚪 Logout (end session)
const logout = async (req, res) => {
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
      "SELECT logout($1)",
      [session_token]
    );

    const success = result.rows[0].logout;

    if (success) {
      res.json({
        status: "success",
        timestamp: new Date().toISOString(),
        data: { message: "Session terminated" }
      });
    } else {
      res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Session not found or already inactive"
      });
    }
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

module.exports = { login, validateSession, logout };