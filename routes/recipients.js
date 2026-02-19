const express = require("express");
const router = express.Router();
const {
  getRecipients,
  createRecipient,
  updateRecipient,
  deleteRecipient,
  getRecipientByPaymentIdentifier
} = require("../controllers/recipientsController");
const validateSession = require("../middleware/validateSession");

// Lookup recipient by payment_identifier (must be before /:id routes)
router.get("/lookup", validateSession, getRecipientByPaymentIdentifier);

// Get all recipients
router.get("/", validateSession, getRecipients);

// Create a new recipient
router.post("/", validateSession, createRecipient);

// Update a recipient
router.put("/:id", validateSession, updateRecipient);

// Delete a recipient
router.delete("/:id", validateSession, deleteRecipient);

module.exports = router;
