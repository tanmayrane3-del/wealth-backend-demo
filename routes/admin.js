const express = require("express");
const router = express.Router();
const { getSmsQueue, updateSmsQueue } = require("../controllers/adminController");

// GET  /api/admin/sms-queue  — check queue count from browser
// POST /api/admin/sms-queue  — Android reports current pending count
router.get("/sms-queue", getSmsQueue);
router.post("/sms-queue", updateSmsQueue);

module.exports = router;
