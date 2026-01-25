const express = require("express");
const router = express.Router();
const {
  getIncomeCategories,
  getExpenseCategories,
  createIncomeCategory,
  updateIncomeCategory,
  createExpenseCategory,
  updateExpenseCategory
} = require("../controllers/categoriesController");
const validateSession = require("../middleware/validateSession");

// Income category routes
router.get("/income", validateSession, getIncomeCategories);
router.post("/income", validateSession, createIncomeCategory);
router.put("/income/:id", validateSession, updateIncomeCategory);

// Expense category routes
router.get("/expense", validateSession, getExpenseCategories);
router.post("/expense", validateSession, createExpenseCategory);
router.put("/expense/:id", validateSession, updateExpenseCategory);

module.exports = router;