const express = require("express");
const router = express.Router();
const { addExpense, getUserExpenses } = require("../controllers/expensesController");
const validateSession = require("../middleware/validateSession");

router.post("/", validateSession, addExpense);
router.get("/", validateSession, getUserExpenses);

module.exports = router;