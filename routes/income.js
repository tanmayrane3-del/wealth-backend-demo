const express = require("express");
const router = express.Router();
const { addIncome, getUserIncome } = require("../controllers/incomeController");
const validateSession = require("../middleware/validateSession");

router.post("/", validateSession, addIncome);
router.get("/", validateSession, getUserIncome);

module.exports = router;