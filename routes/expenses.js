const express = require("express");
const router = express.Router();
const { 
  addExpense, 
  getUserExpenses,
  getExpenseById,
  updateExpense,
  deleteExpense,
  getExpenseSummary
} = require("../controllers/expensesController");
const validateSession = require("../middleware/validateSession");

// Existing routes
router.post("/", validateSession, addExpense);
router.get("/", validateSession, getUserExpenses);

// NEW routes
router.get("/summary", validateSession, getExpenseSummary);
router.get("/:expense_id", validateSession, getExpenseById);
router.put("/:expense_id", validateSession, updateExpense);
router.delete("/:expense_id", validateSession, deleteExpense);

module.exports = router;