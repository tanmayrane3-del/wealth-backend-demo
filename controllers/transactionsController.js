const pool = require("../db");

// Get all transactions (combined income + expenses) with advanced filtering
const getAllTransactions = async (req, res) => {
  const user_id = req.user_id;
  const {
    start_date,
    end_date,
    start_time,
    end_time,
    type, // 'income', 'expense', or 'both'
    category_id,
    source_id,
    recipient_id,
    min_amount,
    max_amount,
    payment_method,
    search
  } = req.query;

  try {
    let incomeQuery = `
      SELECT 
        i.income_id as transaction_id,
        'income' as transaction_type,
        i.date,
        i.time,
        i.amount,
        i.currency,
        ic.name AS category_name,
        ic.icon AS category_icon,
        ic.color AS category_color,
        s.name AS source_name,
        NULL AS recipient_name,
        i.payment_method,
        i.transaction_reference,
        i.notes,
        i.tags,
        i.created_at
      FROM income i
      LEFT JOIN income_categories ic ON i.category_id = ic.id
      LEFT JOIN income_sources s ON i.source_id = s.id
      WHERE i.user_id = $1 AND i.is_deleted = false
    `;

    let expenseQuery = `
      SELECT 
        e.expense_id as transaction_id,
        'expense' as transaction_type,
        e.date,
        e.time,
        e.amount,
        e.currency,
        ec.name AS category_name,
        ec.icon AS category_icon,
        ec.color AS category_color,
        NULL AS source_name,
        r.name AS recipient_name,
        e.payment_method,
        e.transaction_reference,
        e.notes,
        e.tags,
        e.created_at
      FROM expenses e
      LEFT JOIN expense_categories ec ON e.category_id = ec.id
      LEFT JOIN recipients r ON e.recipient_id = r.id
      WHERE e.user_id = $1 AND e.is_deleted = false
    `;

    const params = [user_id];
    let paramCount = 1;

    // Build filter conditions
    const buildFilters = (baseQuery, isIncome) => {
      let query = baseQuery;

      // Date range filter
      if (start_date) {
        paramCount++;
        query += ` AND ${isIncome ? 'i' : 'e'}.date >= $${paramCount}`;
        params.push(start_date);
      }
      if (end_date) {
        paramCount++;
        query += ` AND ${isIncome ? 'i' : 'e'}.date <= $${paramCount}`;
        params.push(end_date);
      }

      // Time range filter
      if (start_time) {
        paramCount++;
        query += ` AND ${isIncome ? 'i' : 'e'}.time >= $${paramCount}`;
        params.push(start_time);
      }
      if (end_time) {
        paramCount++;
        query += ` AND ${isIncome ? 'i' : 'e'}.time <= $${paramCount}`;
        params.push(end_time);
      }

      // Amount range filter
      if (min_amount) {
        paramCount++;
        query += ` AND ${isIncome ? 'i' : 'e'}.amount >= $${paramCount}`;
        params.push(min_amount);
      }
      if (max_amount) {
        paramCount++;
        query += ` AND ${isIncome ? 'i' : 'e'}.amount <= $${paramCount}`;
        params.push(max_amount);
      }

      // Payment method filter
      if (payment_method) {
        paramCount++;
        query += ` AND ${isIncome ? 'i' : 'e'}.payment_method = $${paramCount}`;
        params.push(payment_method);
      }

      // Category filter (income or expense specific)
      if (category_id) {
        paramCount++;
        query += ` AND ${isIncome ? 'i' : 'e'}.category_id = $${paramCount}`;
        params.push(category_id);
      }

      // Source filter (income only)
      if (isIncome && source_id) {
        paramCount++;
        query += ` AND i.source_id = $${paramCount}`;
        params.push(source_id);
      }

      // Recipient filter (expense only)
      if (!isIncome && recipient_id) {
        paramCount++;
        query += ` AND e.recipient_id = $${paramCount}`;
        params.push(recipient_id);
      }

      // Search filter (searches in notes, category name, source/recipient name)
      if (search) {
        paramCount++;
        if (isIncome) {
          query += ` AND (
            i.notes ILIKE $${paramCount} OR 
            ic.name ILIKE $${paramCount} OR 
            s.name ILIKE $${paramCount}
          )`;
        } else {
          query += ` AND (
            e.notes ILIKE $${paramCount} OR 
            ec.name ILIKE $${paramCount} OR 
            r.name ILIKE $${paramCount}
          )`;
        }
        params.push(`%${search}%`);
      }

      return query;
    };

    // Apply filters based on transaction type
    let finalQuery = '';
    
    if (!type || type === 'both') {
      // Combine both income and expenses
      incomeQuery = buildFilters(incomeQuery, true);
      expenseQuery = buildFilters(expenseQuery, false);
      finalQuery = `${incomeQuery} UNION ALL ${expenseQuery} ORDER BY date DESC, time DESC`;
    } else if (type === 'income') {
      // Only income
      incomeQuery = buildFilters(incomeQuery, true);
      finalQuery = `${incomeQuery} ORDER BY date DESC, time DESC`;
    } else if (type === 'expense') {
      // Only expenses
      expenseQuery = buildFilters(expenseQuery, false);
      finalQuery = `${expenseQuery} ORDER BY date DESC, time DESC`;
    }

    const result = await pool.query(finalQuery, params);

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows
    });

  } catch (err) {
    console.error("Get all transactions error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

module.exports = {
  getAllTransactions
};