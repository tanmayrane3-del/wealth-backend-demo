const express    = require("express");
const router     = express.Router();
const validateSession = require("../middleware/validateSession");
const {
  getSignal,
  getHistory,
  getAccuracy,
  getDailyFactors,
  getBacktest,
  getHealth,
  triggerJob,
} = require("../controllers/macroController");

router.get("/signal",   validateSession, getSignal);
router.get("/history",  validateSession, getHistory);
router.get("/accuracy", validateSession, getAccuracy);
router.get("/daily",    validateSession, getDailyFactors);
router.get("/backtest", validateSession, getBacktest);
router.get("/health",   getHealth);
router.post("/trigger", triggerJob);

module.exports = router;
