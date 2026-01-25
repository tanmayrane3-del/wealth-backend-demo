const pool = require("../db");

// Create a new income category for the user
const createIncomeCategory = async (req, res) => {
  const user_id = req.user_id;
  const { name, description, icon, color, display_order } = req.body;

  if (!name) {
    return res.status(400).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: "Name is required"
    });
  }

  try {
    // Check if category with same name already exists for this user
    const existingCategory = await pool.query(
      `SELECT id FROM income_categories
       WHERE LOWER(name) = LOWER($1)
       AND (user_id = $2 OR (user_id IS NULL AND is_global = true))
       AND is_active = true`,
      [name, user_id]
    );

    if (existingCategory.rows.length > 0) {
      return res.status(409).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Category with this name already exists"
      });
    }

    const result = await pool.query(
      `INSERT INTO income_categories (
        user_id, name, description, icon, color, display_order,
        is_default, is_global, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, false, false, true)
      RETURNING id, user_id, name, description, icon, color,
                is_default, is_active, display_order, created_at`,
      [user_id, name, description || null, icon || null, color || null, display_order || 0]
    );

    res.status(201).json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Create income category error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Update an income category (only if owned by user)
const updateIncomeCategory = async (req, res) => {
  const user_id = req.user_id;
  const { id } = req.params;
  const { name, description, icon, color, display_order, is_active } = req.body;

  try {
    // Check if category exists and belongs to the user
    const categoryCheck = await pool.query(
      `SELECT id, is_default, is_global FROM income_categories WHERE id = $1`,
      [id]
    );

    if (categoryCheck.rows.length === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Category not found"
      });
    }

    const category = categoryCheck.rows[0];

    // Prevent updating default/global categories
    if (category.is_default || category.is_global) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot modify default or global categories"
      });
    }

    // Check ownership
    const ownershipCheck = await pool.query(
      `SELECT id FROM income_categories WHERE id = $1 AND user_id = $2`,
      [id, user_id]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "You can only update your own categories"
      });
    }

    // If name is being changed, check for duplicates
    if (name) {
      const duplicateCheck = await pool.query(
        `SELECT id FROM income_categories
         WHERE LOWER(name) = LOWER($1)
         AND id != $2
         AND (user_id = $3 OR (user_id IS NULL AND is_global = true))
         AND is_active = true`,
        [name, id, user_id]
      );

      if (duplicateCheck.rows.length > 0) {
        return res.status(409).json({
          status: "fail",
          timestamp: new Date().toISOString(),
          reason: "Category with this name already exists"
        });
      }
    }

    const result = await pool.query(
      `UPDATE income_categories
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           icon = COALESCE($3, icon),
           color = COALESCE($4, color),
           display_order = COALESCE($5, display_order),
           is_active = COALESCE($6, is_active),
           updated_at = NOW()
       WHERE id = $7 AND user_id = $8
       RETURNING id, user_id, name, description, icon, color,
                 is_default, is_active, display_order, updated_at`,
      [name, description, icon, color, display_order, is_active, id, user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Update income category error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Get all income categories for the user
const getIncomeCategories = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT 
        id,
        name,
        description,
        icon,
        color,
        is_default,
        is_active,
        display_order
      FROM income_categories
      WHERE (user_id = $1 OR user_id IS NULL OR is_default = true)
        AND is_active = true
      ORDER BY display_order ASC, name ASC`,
      [user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows
    });
  } catch (err) {
    console.error("Get income categories error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Get all expense categories for the user
const getExpenseCategories = async (req, res) => {
  const user_id = req.user_id;

  try {
    const result = await pool.query(
      `SELECT
        id,
        name,
        description,
        icon,
        color,
        is_default,
        is_active,
        monthly_budget_limit,
        display_order
      FROM expense_categories
      WHERE (user_id = $1 OR user_id IS NULL OR is_default = true)
        AND is_active = true
      ORDER BY display_order ASC, name ASC`,
      [user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows
    });
  } catch (err) {
    console.error("Get expense categories error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Create a new expense category for the user
const createExpenseCategory = async (req, res) => {
  const user_id = req.user_id;
  const { name, description, icon, color, display_order, monthly_budget_limit } = req.body;

  if (!name) {
    return res.status(400).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: "Name is required"
    });
  }

  try {
    // Check if category with same name already exists for this user
    const existingCategory = await pool.query(
      `SELECT id FROM expense_categories
       WHERE LOWER(name) = LOWER($1)
       AND (user_id = $2 OR (user_id IS NULL AND is_global = true))
       AND is_active = true`,
      [name, user_id]
    );

    if (existingCategory.rows.length > 0) {
      return res.status(409).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Category with this name already exists"
      });
    }

    const result = await pool.query(
      `INSERT INTO expense_categories (
        user_id, name, description, icon, color, display_order,
        monthly_budget_limit, is_default, is_global, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, false, true)
      RETURNING id, user_id, name, description, icon, color,
                is_default, is_active, monthly_budget_limit, display_order, created_at`,
      [user_id, name, description || null, icon || null, color || null,
       display_order || 0, monthly_budget_limit || null]
    );

    res.status(201).json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Create expense category error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Update an expense category (only if owned by user)
const updateExpenseCategory = async (req, res) => {
  const user_id = req.user_id;
  const { id } = req.params;
  const { name, description, icon, color, display_order, monthly_budget_limit, is_active } = req.body;

  try {
    // Check if category exists and belongs to the user
    const categoryCheck = await pool.query(
      `SELECT id, is_default, is_global FROM expense_categories WHERE id = $1`,
      [id]
    );

    if (categoryCheck.rows.length === 0) {
      return res.status(404).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Category not found"
      });
    }

    const category = categoryCheck.rows[0];

    // Prevent updating default/global categories
    if (category.is_default || category.is_global) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot modify default or global categories"
      });
    }

    // Check ownership
    const ownershipCheck = await pool.query(
      `SELECT id FROM expense_categories WHERE id = $1 AND user_id = $2`,
      [id, user_id]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "You can only update your own categories"
      });
    }

    // If name is being changed, check for duplicates
    if (name) {
      const duplicateCheck = await pool.query(
        `SELECT id FROM expense_categories
         WHERE LOWER(name) = LOWER($1)
         AND id != $2
         AND (user_id = $3 OR (user_id IS NULL AND is_global = true))
         AND is_active = true`,
        [name, id, user_id]
      );

      if (duplicateCheck.rows.length > 0) {
        return res.status(409).json({
          status: "fail",
          timestamp: new Date().toISOString(),
          reason: "Category with this name already exists"
        });
      }
    }

    const result = await pool.query(
      `UPDATE expense_categories
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           icon = COALESCE($3, icon),
           color = COALESCE($4, color),
           display_order = COALESCE($5, display_order),
           monthly_budget_limit = COALESCE($6, monthly_budget_limit),
           is_active = COALESCE($7, is_active),
           updated_at = NOW()
       WHERE id = $8 AND user_id = $9
       RETURNING id, user_id, name, description, icon, color,
                 is_default, is_active, monthly_budget_limit, display_order, updated_at`,
      [name, description, icon, color, display_order, monthly_budget_limit, is_active, id, user_id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: result.rows[0]
    });
  } catch (err) {
    console.error("Update expense category error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

module.exports = {
  getIncomeCategories,
  getExpenseCategories,
  createIncomeCategory,
  updateIncomeCategory,
  createExpenseCategory,
  updateExpenseCategory
};
