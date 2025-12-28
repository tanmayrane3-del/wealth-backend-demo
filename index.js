const express = require("express");
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});