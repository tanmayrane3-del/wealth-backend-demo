const express = require("express");
const router = express.Router();
const validateSession = require("../middleware/validateSession");
const { parseSmsAndRecord } = require("../controllers/smsController");

// POST /api/sms/parse
// Receives raw SMS from Android, parses with Claude Haiku, saves expense
router.post("/parse", validateSession, parseSmsAndRecord);

module.exports = router;
