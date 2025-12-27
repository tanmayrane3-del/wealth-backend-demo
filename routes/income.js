const express = require("express");
const router = express.Router();
const { 
  addIncome, 
  getUserIncome,
  getIncomeById,
  updateIncome,
  deleteIncome,
  getIncomeSummary
} = require("../controllers/incomeController");
const validateSession = require("../middleware/validateSession");

// Existing routes
router.post("/", validateSession, addIncome);
router.get("/", validateSession, getUserIncome);

// NEW routes
router.get("/summary", validateSession, getIncomeSummary);
router.get("/:income_id", validateSession, getIncomeById);
router.put("/:income_id", validateSession, updateIncome);
router.delete("/:income_id", validateSession, deleteIncome);

module.exports = router;