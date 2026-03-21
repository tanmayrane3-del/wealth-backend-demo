const express = require("express");
const router = express.Router();
const validateSession = require("../middleware/validateSession");
const {
  getLiabilities, getSummary, getLiabilityById,
  createLiability, updateLiability, deleteLiability,
} = require("../controllers/liabilitiesController");

router.get("/summary", validateSession, getSummary);
router.get("/",        validateSession, getLiabilities);
router.get("/:id",     validateSession, getLiabilityById);
router.post("/",       validateSession, createLiability);
router.put("/:id",     validateSession, updateLiability);
router.delete("/:id",  validateSession, deleteLiability);

module.exports = router;
