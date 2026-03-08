const express = require("express");
const router = express.Router();
const { handleKiteCallback } = require("../controllers/zerodhaController");

// Public route — no session middleware.
// Zerodha redirects here after user login.
router.get("/auth/callback", handleKiteCallback);

module.exports = router;
