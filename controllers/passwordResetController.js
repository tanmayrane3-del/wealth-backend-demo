const pool = require("../db");
const { success, fail } = require("../utils/respond");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Request password reset (generates OTP)
const requestPasswordReset = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return fail(res, "Email is required", 400);
  }

  try {
    // Check if user exists
    const userResult = await pool.query(
      "SELECT user_id, email, full_name FROM users WHERE email = $1",
      [email]
    );

    if (userResult.rowCount === 0) {
      // For security, don't reveal if email exists
      return success(res, {
        message: "If the email exists, an OTP has been sent"
      }, 200);
    }

    const user = userResult.rows[0];
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store OTP in database
    await pool.query(
      `INSERT INTO password_reset_otps (user_id, otp, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) 
       DO UPDATE SET otp = $2, expires_at = $3, created_at = NOW(), is_used = false`,
      [user.user_id, otp, expiresAt]
    );

    // In production, send OTP via email here
    // For now, return it in response (REMOVE IN PRODUCTION!)
    console.log(`OTP for ${email}: ${otp}`);

    success(res, {
      message: "OTP sent successfully",
      // REMOVE THIS IN PRODUCTION - only for testing
      otp: otp,
      email: email
    }, 200);

  } catch (err) {
    console.error("Request password reset error:", err);
    fail(res, err.message, 500);
  }
};

// Verify OTP (optional step to check OTP before password change)
const verifyOTP = async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return fail(res, "Email and OTP are required", 400);
  }

  try {
    const result = await pool.query(
      `SELECT pro.otp_id, pro.user_id, u.email
       FROM password_reset_otps pro
       JOIN users u ON pro.user_id = u.user_id
       WHERE u.email = $1 
       AND pro.otp = $2 
       AND pro.expires_at > NOW()
       AND pro.is_used = false`,
      [email, otp]
    );

    if (result.rowCount === 0) {
      return fail(res, "Invalid or expired OTP", 401);
    }

    success(res, {
      message: "OTP verified successfully",
      user_id: result.rows[0].user_id
    }, 200);

  } catch (err) {
    console.error("Verify OTP error:", err);
    fail(res, err.message, 500);
  }
};

// Reset password with OTP
const resetPassword = async (req, res) => {
  const { email, otp, new_password } = req.body;

  if (!email || !otp || !new_password) {
    return fail(res, "Email, OTP, and new password are required", 400);
  }

  if (new_password.length < 6) {
    return fail(res, "Password must be at least 6 characters", 400);
  }

  try {
    // Verify OTP
    const otpResult = await pool.query(
      `SELECT pro.otp_id, pro.user_id, u.email
       FROM password_reset_otps pro
       JOIN users u ON pro.user_id = u.user_id
       WHERE u.email = $1 
       AND pro.otp = $2 
       AND pro.expires_at > NOW()
       AND pro.is_used = false`,
      [email, otp]
    );

    if (otpResult.rowCount === 0) {
      return fail(res, "Invalid or expired OTP", 401);
    }

    const user_id = otpResult.rows[0].user_id;

    // Hash new password
    const password_hash = await bcrypt.hash(new_password, 10);

    // Update password
    await pool.query(
      "UPDATE users SET password_hash = $1 WHERE user_id = $2",
      [password_hash, user_id]
    );

    // Mark OTP as used
    await pool.query(
      "UPDATE password_reset_otps SET is_used = true WHERE user_id = $1",
      [user_id]
    );

    // Invalidate all existing sessions for security
    await pool.query(
      "UPDATE user_sessions SET is_active = false WHERE user_id = $1",
      [user_id]
    );

    success(res, {
      message: "Password reset successfully. Please login with new password."
    }, 200);

  } catch (err) {
    console.error("Reset password error:", err);
    fail(res, err.message, 500);
  }
};

module.exports = { 
  requestPasswordReset, 
  verifyOTP, 
  resetPassword 
};