const express  = require("express");
const multer   = require("multer");
const router   = express.Router();
const validate = require("../middleware/validateSession");
const {
  lookupScheme,
  parseCasPdf,
  confirmCasImport,
  getHoldings,
  getSummary,
  addLot,
  deleteLot,
  syncMfCagr,
} = require("../controllers/mutualFundsController");

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB cap
});

router.get("/lookup",          validate, lookupScheme);
router.post("/cas/upload",     validate, upload.single("pdf"), parseCasPdf);
router.post("/cas/confirm",    validate, confirmCasImport);
router.get("/holdings",        validate, getHoldings);
router.get("/summary",         validate, getSummary);
router.post("/holdings",       validate, addLot);
router.delete("/holdings/:id", validate, deleteLot);
router.post("/sync-cagr",      validate, syncMfCagr);

module.exports = router;
