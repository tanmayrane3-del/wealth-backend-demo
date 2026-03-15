const express = require("express");
const router = express.Router();
const validateSession = require("../middleware/validateSession");
const {
  getRates,
  getHoldings,
  addHolding,
  updateHolding,
  deleteHolding,
  getMetalsSummary,
  syncMetalsCagr,
} = require("../controllers/metalsController");

router.get("/rates",           validateSession, getRates);
router.get("/summary",         validateSession, getMetalsSummary);
router.post("/sync-cagr",      validateSession, syncMetalsCagr);
router.get("/holdings",        validateSession, getHoldings);
router.post("/holdings",       validateSession, addHolding);
router.put("/holdings/:id",    validateSession, updateHolding);
router.delete("/holdings/:id", validateSession, deleteHolding);

module.exports = router;
