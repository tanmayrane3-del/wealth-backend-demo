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

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

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