const { runMarketSync } = require("../services/marketSync");

// In-memory queue stats — resets on server restart (sufficient for personal monitoring)
let queueStats = { pending: 0, lastReported: null };

const getSmsQueue = (req, res) => {
    res.json({ status: "success", data: queueStats });
};

const updateSmsQueue = (req, res) => {
    const { pending } = req.body;
    if (typeof pending !== "number") {
        return res.status(400).json({ status: "error", reason: "pending must be a number" });
    }
    queueStats = { pending, lastReported: new Date().toISOString() };
    res.json({ status: "success" });
};

/**
 * GET /api/admin/sync-now
 * Manually triggers a full holdings sync for all active users.
 * No auth required — for development and testing only.
 */
const triggerSyncNow = async (req, res) => {
  try {
    console.log("[Admin] Manual sync triggered via /admin/sync-now");
    await runMarketSync();
    return res.json({ status: "success", data: { message: "Sync complete" } });
  } catch (err) {
    console.error("[Admin] Manual sync error:", err.message);
    return res.status(500).json({ status: "fail", reason: err.message });
  }
};

module.exports = { getSmsQueue, updateSmsQueue, triggerSyncNow };
