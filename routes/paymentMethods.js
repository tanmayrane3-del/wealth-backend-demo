const express = require("express");
const router = express.Router();
const { getPaymentMethods } = require("../controllers/paymentMethodsController");
const validateSession = require("../middleware/validateSession");

// Get all payment methods
router.get("/", validateSession, getPaymentMethods);

module.exports = router;