const express = require("express");
const router = express.Router();
const validateSession = require("../middleware/validateSession");
const {
  getCurrent,
  getSnapshots,
  upsertSnapshotForAllUsers,
} = require("../controllers/netWorthController");

// User-facing endpoints — require session token
router.get("/current",   validateSession, getCurrent);
router.get("/snapshots", validateSession, getSnapshots);

// Internal endpoint — called by cron job, no session required
router.post("/snapshot", upsertSnapshotForAllUsers);

module.exports = router;
