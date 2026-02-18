const express = require("express");
const router = express.Router();
const {
  getIncomeSources,
  createIncomeSource,
  updateIncomeSource,
  deleteIncomeSource
} = require("../controllers/sourcesController");
const validateSession = require("../middleware/validateSession");

// Get all income sources
router.get("/", validateSession, getIncomeSources);

// Create a new income source
router.post("/", validateSession, createIncomeSource);

// Update an income source
router.put("/:id", validateSession, updateIncomeSource);

// Delete an income source
router.delete("/:id", validateSession, deleteIncomeSource);

module.exports = router;
