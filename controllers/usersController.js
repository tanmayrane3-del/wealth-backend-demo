const pool = require("../db");
const { success, fail } = require("../utils/respond");
const bcrypt = require("bcryptjs");

const createUser = async (req, res) => {
  const { email, password, full_name, phone } = req.body;

  if (!email || !password || !full_name || !phone) {
    return fail(res, "All fields (email, password, full_name, phone) are required", 400);
  }

  try {
    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "SELECT create_user($1, $2, $3, $4)",
      [email, password_hash, full_name, phone]
    );

    success(res, {
      user_id: result.rows[0].create_user,
      email,
      full_name,
      phone,
      is_active: true,
      is_email_verified: false
    }, 201);
  } catch (err) {
    console.error("Create user error:", err);
    fail(res, err.message, 500);
  }
};

const getUserByEmail = async (req, res) => {
  const email = req.query.email;
  if (!email) return fail(res, "Email is required", 400);

  try {
    const result = await pool.query(
      `SELECT user_id, email, full_name, is_active, is_email_verified, created_at 
       FROM users 
       WHERE email = $1`,
      [email]
    );

    if (result.rowCount === 0) {
      return fail(res, "User not found", 404);
    }

    success(res, result.rows[0], 200);
  } catch (err) {
    console.error("Get user error:", err);
    fail(res, err.message, 500);
  }
};

module.exports = { createUser, getUserByEmail };