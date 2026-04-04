// Force IPv4 DNS resolution — Render free tier is IPv4-only but
// Node.js 18+ defaults to verbatim order (prefers AAAA/IPv6 records first)
require("dns").setDefaultResultOrder("ipv4first");

const express = require("express");
const https = require("https");
const http = require("http");
const app = express();
const PORT = process.env.PORT || 3000;
const sessionRoutes = require("./routes/sessions");


app.use(express.json());

// Import routes
const userRoutes = require("./routes/users");
const incomeRoutes = require("./routes/income");
const expenseRoutes = require("./routes/expenses");
const passwordResetRoutes = require("./routes/passwordReset");
const transactionsRoutes = require("./routes/transactions");
const categoriesRoutes = require("./routes/categories");
const sourcesRoutes = require("./routes/sources");
const recipientsRoutes = require("./routes/recipients");
const paymentMethodsRoutes = require("./routes/paymentMethods");
const smsRoutes = require("./routes/sms");
const adminRoutes = require("./routes/admin");
const zerodhaRoutes = require("./routes/zerodha");
const holdingsRoutes = require("./routes/holdings");
const kiteRoutes = require("./routes/kite");
const metalsRoutes       = require("./routes/metals");
const cagrRoutes         = require("./routes/cagr");
const mutualFundsRoutes  = require("./routes/mutualFunds");
const physicalAssetsRoutes = require("./routes/physicalAssets");
const liabilitiesRoutes    = require("./routes/liabilities");
const netWorthRoutes       = require("./routes/netWorth");
const cron                 = require("node-cron");
const { calculateCurrentNetWorth } = require("./controllers/netWorthController");

// Use routes
app.use("/api/users", userRoutes);
app.use("/api/income", incomeRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/password-reset", passwordResetRoutes);
app.use("/api/transactions", transactionsRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/sources", sourcesRoutes);
app.use("/api/recipients", recipientsRoutes);
app.use("/api/payment-methods", paymentMethodsRoutes);
app.use("/api/sms", smsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/zerodha", zerodhaRoutes);
app.use("/api/holdings", holdingsRoutes);
app.use("/api/kite", kiteRoutes);
app.use("/api/metals",       metalsRoutes);
app.use("/api/cagr",         cagrRoutes);
app.use("/api/mutual-funds",    mutualFundsRoutes);
app.use("/api/physical-assets", physicalAssetsRoutes);
app.use("/api/liabilities",     liabilitiesRoutes);
app.use("/api/net-worth",       netWorthRoutes);
app.use("/api/macro",          require("./routes/macro"));

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Start automated market-hours holdings sync
  const { initMarketSync } = require("./services/marketSync");
  initMarketSync();

  // Weekly CAGR calculation job (every Sunday 23:00 IST)
  const { initCagrScheduler } = require("./services/cagrCalculator");
  initCagrScheduler();

  // Daily macro factors job (weekdays 7:30pm IST)
  const { startMacroCron, runMacroJob } = require("./jobs/macroJob");
  startMacroCron();

  // Auto-run if server restarted after the cron window was missed
  ;(async () => {
    try {
      const nowIST = new Date().toLocaleString("en-US", {
        timeZone: "Asia/Kolkata",
        hour: "numeric",
        hour12: false,
        weekday: "short",
      });

      const istDate = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
      );
      const dayOfWeek = istDate.getDay();   // 0=Sun, 6=Sat
      const hourIST   = istDate.getHours();

      const isWeekday     = dayOfWeek >= 1 && dayOfWeek <= 5;
      const isAfterMarket = hourIST >= 16;  // after 4pm IST (market closed)

      if (isWeekday && isAfterMarket) {
        const today = new Date().toLocaleDateString("en-CA", {
          timeZone: "Asia/Kolkata",
        });

        const pool = require("./db");
        const result = await pool.query(
          `SELECT date FROM macro_factors_daily WHERE date = $1 LIMIT 1`,
          [today]
        );

        if (!result.rows || result.rows.length === 0) {
          console.log(
            "[MacroJob] Server restarted after market close —",
            "no data for today yet, triggering catch-up run"
          );
          runMacroJob().catch((err) =>
            console.error("[MacroJob] Catch-up run error:", err.message)
          );
        }
      }
    } catch (err) {
      console.error("[MacroJob] Startup check failed:", err.message);
    }
  })();

  // Daily net worth snapshot at 11:00 PM IST (17:30 UTC)
  cron.schedule("30 17 * * *", async () => {
    console.log("[net-worth cron] Running daily snapshot for all users...");
    try {
      const usersResult = await pool.query(
        `SELECT user_id FROM users WHERE is_active = true`
      );
      let count = 0;
      for (const row of usersResult.rows) {
        try {
          const { totalAssets, totalLiabilities, netWorth } =
            await calculateCurrentNetWorth(row.user_id);
          await pool.query(
            `INSERT INTO net_worth_snapshots
               (user_id, snapshot_date, total_assets, total_liabilities, net_worth)
             VALUES ($1, CURRENT_DATE, $2, $3, $4)
             ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
               total_assets      = EXCLUDED.total_assets,
               total_liabilities = EXCLUDED.total_liabilities,
               net_worth         = EXCLUDED.net_worth`,
            [row.user_id, totalAssets, totalLiabilities, netWorth]
          );
          count++;
        } catch (e) {
          console.error(`[net-worth cron] Failed for user ${row.user_id}:`, e.message);
        }
      }
      console.log(`[net-worth cron] Done — ${count} snapshot(s) written.`);
    } catch (e) {
      console.error("[net-worth cron] Fatal error:", e.message);
    }
  });

  // Self-ping every 14 minutes to prevent Render from sleeping
  const RENDER_URL = process.env.RENDER_URL;
  if (RENDER_URL) {
    const pingUrl = `${RENDER_URL}/health`;
    const client = pingUrl.startsWith("https") ? https : http;

    setInterval(() => {
      client.get(pingUrl, (res) => {
        console.log(`[Keep-alive] Pinged ${pingUrl} — status: ${res.statusCode}`);
      }).on("error", (err) => {
        console.error(`[Keep-alive] Ping failed: ${err.message}`);
      });
    }, 14 * 60 * 1000); // 14 minutes

    console.log(`[Keep-alive] Self-ping scheduled every 14 min → ${pingUrl}`);
  } else {
    console.warn("[Keep-alive] RENDER_URL not set — self-ping disabled.");
  }
});

// Graceful shutdown — cleanly close DB pool before process exits.
// Without this, Render kills the process abruptly, leaving dangling connections
// in PgBouncer which overwhelms it during the next deployment's startup.
const pool = require("./db");
const shutdown = async (signal) => {
  console.log(`[shutdown] ${signal} received — closing DB pool...`);
  await pool.end();
  console.log("[shutdown] DB pool closed. Exiting.");
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));