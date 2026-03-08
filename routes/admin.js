const express = require("express");
const router = express.Router();
const { getSmsQueue, updateSmsQueue, triggerSyncNow } = require("../controllers/adminController");

// GET  /api/admin/sms-queue  — check queue count from browser
// POST /api/admin/sms-queue  — Android reports current pending count
router.get("/sms-queue", getSmsQueue);
router.post("/sms-queue", updateSmsQueue);

// GET /api/admin/sync-now — manually trigger holdings sync (no auth, dev/testing)
router.get("/sync-now", triggerSyncNow);

module.exports = router;
