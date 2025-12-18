const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;
const sessionRoutes = require("./routes/sessions");


app.use(express.json());

// Import routes
const userRoutes = require("./routes/users");
const incomeRoutes = require("./routes/income");
const expenseRoutes = require("./routes/expenses");

// Use routes
app.use("/api/users", userRoutes);
app.use("/api/income", incomeRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/sessions", sessionRoutes);


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});