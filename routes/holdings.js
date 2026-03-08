const express = require("express");
const router = express.Router();
const { syncHoldings, getHoldings, getHoldingsSummary } = require("../controllers/holdingsController");
const validateSession = require("../middleware/validateSession");

router.get("/sync", validateSession, syncHoldings);
router.get("/summary", validateSession, getHoldingsSummary);
router.get("/", validateSession, getHoldings);

module.exports = router;
