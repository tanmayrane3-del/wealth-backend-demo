const express = require("express");
const router = express.Router();
const { getAllTransactions } = require("../controllers/transactionsController");
const validateSession = require("../middleware/validateSession");

// Get all transactions with filters
router.get("/", validateSession, getAllTransactions);

module.exports = router;