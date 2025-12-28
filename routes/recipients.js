const express = require("express");
const router = express.Router();
const { getRecipients } = require("../controllers/recipientsController");
const validateSession = require("../middleware/validateSession");

// Get all recipients
router.get("/", validateSession, getRecipients);

module.exports = router;