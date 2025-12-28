const express = require("express");
const router = express.Router();
const { 
  getIncomeCategories, 
  getExpenseCategories 
} = require("../controllers/categoriesController");
const validateSession = require("../middleware/validateSession");

// Get income categories
router.get("/income", validateSession, getIncomeCategories);

// Get expense categories
router.get("/expense", validateSession, getExpenseCategories);

module.exports = router;