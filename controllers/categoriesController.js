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
        ic.id,
        ic.name,
        ic.description,
        ic.icon,
        ic.color,
        ic.is_default,
        ic.is_active,
        ic.display_order,
        ic.is_global,
        CASE
          WHEN ic.user_id = $1 AND ic.is_global = false AND ic.is_default = false
          THEN true
          ELSE false
        END as is_user_specific,
        COALESCE(
          (SELECT COUNT(*) FROM income WHERE category_id = ic.id AND user_id = $1),
          0
        )::integer as transaction_count
      FROM income_categories ic
      WHERE (ic.user_id = $1 OR ic.user_id IS NULL OR ic.is_default = true)
        AND ic.is_active = true
      ORDER BY ic.display_order ASC, ic.name ASC`,
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
        ec.id,
        ec.name,
        ec.description,
        ec.icon,
        ec.color,
        ec.is_default,
        ec.is_active,
        ec.monthly_budget_limit,
        ec.display_order,
        ec.is_global,
        CASE
          WHEN ec.user_id = $1 AND ec.is_global = false AND ec.is_default = false
          THEN true
          ELSE false
        END as is_user_specific,
        COALESCE(
          (SELECT COUNT(*) FROM expenses WHERE category_id = ec.id AND user_id = $1),
          0
        )::integer as transaction_count
      FROM expense_categories ec
      WHERE (ec.user_id = $1 OR ec.user_id IS NULL OR ec.is_default = true)
        AND ec.is_active = true
      ORDER BY ec.display_order ASC, ec.name ASC`,
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

// Delete an income category (only if owned by user and has no transactions)
const deleteIncomeCategory = async (req, res) => {
  const user_id = req.user_id;
  const { id } = req.params;

  try {
    // Check if category exists
    const categoryCheck = await pool.query(
      `SELECT id, is_default, is_global, user_id FROM income_categories WHERE id = $1`,
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

    // Prevent deleting default/global categories
    if (category.is_default || category.is_global) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot delete default or global categories"
      });
    }

    // Check ownership
    if (category.user_id !== user_id) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "You can only delete your own categories"
      });
    }

    // Check if category has transactions
    const transactionCheck = await pool.query(
      `SELECT COUNT(*) as count FROM income WHERE category_id = $1 AND user_id = $2`,
      [id, user_id]
    );

    if (parseInt(transactionCheck.rows[0].count) > 0) {
      return res.status(409).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot delete category with existing transactions"
      });
    }

    // Soft delete the category
    await pool.query(
      `UPDATE income_categories SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      message: "Category deleted successfully"
    });
  } catch (err) {
    console.error("Delete income category error:", err);
    res.status(500).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: err.message
    });
  }
};

// Delete an expense category (only if owned by user and has no transactions)
const deleteExpenseCategory = async (req, res) => {
  const user_id = req.user_id;
  const { id } = req.params;

  try {
    // Check if category exists
    const categoryCheck = await pool.query(
      `SELECT id, is_default, is_global, user_id FROM expense_categories WHERE id = $1`,
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

    // Prevent deleting default/global categories
    if (category.is_default || category.is_global) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot delete default or global categories"
      });
    }

    // Check ownership
    if (category.user_id !== user_id) {
      return res.status(403).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "You can only delete your own categories"
      });
    }

    // Check if category has transactions
    const transactionCheck = await pool.query(
      `SELECT COUNT(*) as count FROM expenses WHERE category_id = $1 AND user_id = $2`,
      [id, user_id]
    );

    if (parseInt(transactionCheck.rows[0].count) > 0) {
      return res.status(409).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Cannot delete category with existing transactions"
      });
    }

    // Soft delete the category
    await pool.query(
      `UPDATE expense_categories SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id]
    );

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      message: "Category deleted successfully"
    });
  } catch (err) {
    console.error("Delete expense category error:", err);
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
  updateExpenseCategory,
  deleteIncomeCategory,
  deleteExpenseCategory
};
