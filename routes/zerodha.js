const express = require("express");
const router = express.Router();
const { saveCredentials, getAuthUrl, handleCallback } = require("../controllers/zerodhaController");
const validateSession = require("../middleware/validateSession");

router.post("/credentials", validateSession, saveCredentials);
router.get("/auth-url", validateSession, getAuthUrl);
router.post("/callback", validateSession, handleCallback);

module.exports = router;
