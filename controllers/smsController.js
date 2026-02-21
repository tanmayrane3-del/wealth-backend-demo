const pool = require("../db");
const { parseSms } = require("../utils/smsParser");

// Expense fallbacks
const OTHER_CATEGORY_ID = "7d659682-2cb0-4a0e-bcad-0440efcaf7f5";
const OTHER_RECIPIENT_ID = "60c07db2-5f7d-4492-97a8-d584295b5605";

// Income fallbacks — replace with actual UUIDs from your DB
const OTHER_INCOME_CATEGORY_ID = "REPLACE_WITH_OTHER_INCOME_CATEGORY_UUID";
const OTHER_SOURCE_ID = "REPLACE_WITH_OTHER_SOURCE_UUID";

/**
 * POST /api/sms/parse
 * Body: { sender, body, timestamp_ms }
 * Header: x-session-token (validated by middleware)
 *
 * Parses a raw bank SMS using Claude Haiku and saves expense to DB.
 */
const parseSmsAndRecord = async (req, res) => {
  const user_id = req.user_id;
  const { sender, body, timestamp_ms } = req.body;

  if (!sender || !body) {
    return res.status(400).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: "sender and body are required"
    });
  }

  const receivedDate = new Date(timestamp_ms || Date.now()).toISOString();

  let parsed;
  try {
    parsed = await parseSms(sender, body, receivedDate);
  } catch (err) {
    console.error("[SMS] Claude parse error:", err.message);
    return res.status(502).json({
      status: "fail",
      timestamp: new Date().toISOString(),
      reason: "SMS parsing failed: " + err.message
    });
  }

  // Not a bank transaction at all — skip silently
  if (!parsed.is_transaction) {
    return res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      data: { recorded: false, reason: "Not a bank transaction" }
    });
  }

  if (parsed.transaction_direction === "credit") {
    // ── INCOME PATH ──────────────────────────────────────────────
    let sourceId = OTHER_SOURCE_ID;
    let incomeCategoryId = OTHER_INCOME_CATEGORY_ID;
    let sourceName = parsed.payment_identifier || "Unknown";

    if (parsed.payment_identifier) {
      try {
        const sourceResult = await pool.query(
          `SELECT id, name, default_category_id
           FROM income_sources
           WHERE (user_id = $1 OR user_id IS NULL OR is_default = true)
             AND is_active = true
             AND LOWER(source_identifier) = LOWER($2)
           LIMIT 1`,
          [user_id, parsed.payment_identifier]
        );

        if (sourceResult.rows.length > 0) {
          const source = sourceResult.rows[0];
          sourceId = source.id;
          sourceName = source.name;
          if (source.default_category_id) {
            incomeCategoryId = source.default_category_id;
          }
        }
      } catch (err) {
        console.error("[SMS] Source lookup error:", err.message);
        // Continue with defaults — don't fail the whole request
      }
    }

    const notes = `${parsed.date} ${parsed.time} ${sourceName}`;

    try {
      const result = await pool.query(
        `INSERT INTO income (
          user_id, date, time, amount, currency,
          category_id, source_id, payment_method,
          transaction_reference, notes, tags
        ) VALUES (
          $1, $2, $3, $4, 'INR',
          $5, $6, $7,
          $8, $9, $10
        ) RETURNING income_id`,
        [
          user_id,
          parsed.date,
          parsed.time,
          parsed.amount,
          incomeCategoryId,
          sourceId,
          parsed.payment_method,
          parsed.transaction_reference,
          notes,
          ["sms-auto"]
        ]
      );

      return res.status(201).json({
        status: "success",
        timestamp: new Date().toISOString(),
        data: {
          recorded: true,
          type: "income",
          income_id: result.rows[0].income_id,
          amount: parsed.amount,
          source: sourceName,
          bank: parsed.bank_sender,
          is_unmatched: sourceId === OTHER_SOURCE_ID
        }
      });
    } catch (err) {
      console.error("[SMS] Insert income error:", err.message);
      return res.status(500).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Failed to save income: " + err.message
      });
    }

  } else {
    // ── EXPENSE PATH (debit) ──────────────────────────────────────
    let recipientId = OTHER_RECIPIENT_ID;
    let categoryId = OTHER_CATEGORY_ID;
    let recipientName = parsed.payment_identifier || "Unknown";

    if (parsed.payment_identifier) {
      try {
        const recipientResult = await pool.query(
          `SELECT id, name, category_id
           FROM recipients
           WHERE (user_id = $1 OR user_id IS NULL OR is_default = true)
             AND is_active = true
             AND LOWER(payment_identifier) = LOWER($2)
           LIMIT 1`,
          [user_id, parsed.payment_identifier]
        );

        if (recipientResult.rows.length > 0) {
          const recipient = recipientResult.rows[0];
          recipientId = recipient.id;
          recipientName = recipient.name;
          if (recipient.category_id) {
            categoryId = recipient.category_id;
          }
        }
      } catch (err) {
        console.error("[SMS] Recipient lookup error:", err.message);
        // Continue with defaults — don't fail the whole request
      }
    }

    const notes = `${parsed.date} ${parsed.time} ${recipientName}`;

    try {
      const result = await pool.query(
        `INSERT INTO expenses (
          user_id, date, time, amount, currency,
          category_id, recipient_id, payment_method,
          transaction_reference, notes, tags
        ) VALUES (
          $1, $2, $3, $4, 'INR',
          $5, $6, $7,
          $8, $9, $10
        ) RETURNING expense_id`,
        [
          user_id,
          parsed.date,
          parsed.time,
          parsed.amount,
          categoryId,
          recipientId,
          parsed.payment_method,
          parsed.transaction_reference,
          notes,
          ["sms-auto"]
        ]
      );

      return res.status(201).json({
        status: "success",
        timestamp: new Date().toISOString(),
        data: {
          recorded: true,
          type: "expense",
          expense_id: result.rows[0].expense_id,
          amount: parsed.amount,
          recipient: recipientName,
          bank: parsed.bank_sender,
          is_unmatched: recipientId === OTHER_RECIPIENT_ID
        }
      });
    } catch (err) {
      console.error("[SMS] Insert expense error:", err.message);
      return res.status(500).json({
        status: "fail",
        timestamp: new Date().toISOString(),
        reason: "Failed to save expense: " + err.message
      });
    }
  }
};

module.exports = { parseSmsAndRecord };
