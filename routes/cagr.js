const express = require("express");
const router = express.Router();
const validateSession = require("../middleware/validateSession");
const { triggerCagrJob } = require("../controllers/cagrController");

// POST /api/cagr/run — manually trigger the CAGR job (requires valid session)
router.post("/run", validateSession, triggerCagrJob);

module.exports = router;
