const express = require("express");
const router = express.Router();
const {
  getIncomeCategories,
  getExpenseCategories,
  createIncomeCategory,
  updateIncomeCategory,
  createExpenseCategory,
  updateExpenseCategory,
  deleteIncomeCategory,
  deleteExpenseCategory
} = require("../controllers/categoriesController");
const validateSession = require("../middleware/validateSession");

// Income category routes
router.get("/income", validateSession, getIncomeCategories);
router.post("/income", validateSession, createIncomeCategory);
router.put("/income/:id", validateSession, updateIncomeCategory);
router.delete("/income/:id", validateSession, deleteIncomeCategory);

// Expense category routes
router.get("/expense", validateSession, getExpenseCategories);
router.post("/expense", validateSession, createExpenseCategory);
router.put("/expense/:id", validateSession, updateExpenseCategory);
router.delete("/expense/:id", validateSession, deleteExpenseCategory);

module.exports = router;