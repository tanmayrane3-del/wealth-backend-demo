const express = require("express");
const router = express.Router();
const {
  requestPasswordReset,
  verifyOTP,
  resetPassword
} = require("../controllers/passwordResetController");

router.post("/request", requestPasswordReset);
router.post("/verify-otp", verifyOTP);
router.post("/reset", resetPassword);

module.exports = router;