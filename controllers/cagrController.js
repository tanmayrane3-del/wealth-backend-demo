const { runCagrJob } = require("../services/cagrCalculator");
const { success, fail } = require("../utils/respond");

/**
 * POST /api/cagr/run
 * Manually triggers the CAGR calculation job. Useful for testing without
 * waiting for the Sunday night cron. Requires a valid session token.
 */
const triggerCagrJob = async (req, res) => {
  try {
    const result = await runCagrJob();
    return success(res, result);
  } catch (err) {
    console.error("[CAGR] Manual trigger error:", err.message);
    return fail(res, err.message, 500);
  }
};

module.exports = { triggerCagrJob };
