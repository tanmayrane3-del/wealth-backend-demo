const express = require("express");
const router = express.Router();
const {
  getRecipients,
  createRecipient,
  updateRecipient,
  deleteRecipient
} = require("../controllers/recipientsController");
const validateSession = require("../middleware/validateSession");

// Get all recipients
router.get("/", validateSession, getRecipients);

// Create a new recipient
router.post("/", validateSession, createRecipient);

// Update a recipient
router.put("/:id", validateSession, updateRecipient);

// Delete a recipient
router.delete("/:id", validateSession, deleteRecipient);

module.exports = router;
