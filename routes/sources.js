const express = require("express");
const router = express.Router();
const { getIncomeSources } = require("../controllers/sourcesController");
const validateSession = require("../middleware/validateSession");

// Get all income sources
router.get("/", validateSession, getIncomeSources);

module.exports = router;