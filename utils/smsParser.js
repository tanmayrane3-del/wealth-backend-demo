const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SMS_PARSE_SCHEMA = {
  type: "object",
  properties: {
    is_transaction: {
      type: "boolean",
      description: "true if SMS is a bank debit/expense transaction, false otherwise (OTP, promo, balance alert, etc.)"
    },
    amount: {
      type: "string",
      description: "Transaction amount as a decimal string e.g. '500.00'. null if not a transaction."
    },
    payment_identifier: {
      type: "string",
      description: "UPI ID, merchant name, or recipient identifier e.g. 'paytmqr@paytm' or 'Amazon'. null if not found."
    },
    transaction_reference: {
      type: "string",
      description: "Transaction reference/UTR number. null if not found."
    },
    date: {
      type: "string",
      description: "Transaction date in yyyy-MM-dd format. Use today if not in SMS."
    },
    time: {
      type: "string",
      description: "Transaction time in HH:mm format. Use 00:00 if not in SMS."
    },
    payment_method: {
      type: "string",
      enum: ["upi", "credit_card", "debit_card", "net_banking", "wallet", "cash", "other"],
      description: "Payment method used."
    },
    bank_sender: {
      type: "string",
      description: "Short bank name e.g. 'BOB', 'ICICI', 'HDFC'. null if unknown."
    }
  },
  required: ["is_transaction", "amount", "payment_identifier", "transaction_reference", "date", "time", "payment_method", "bank_sender"],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You are an Indian bank SMS parser. Your job is to extract transaction details from bank SMS messages sent to Indian customers.

Rules:
- Only mark is_transaction=true for DEBIT transactions (money going OUT) — these are expenses.
- Mark is_transaction=false for: OTPs, credit transactions (money coming IN), balance alerts, promotional messages, login alerts.
- For UPI payments, payment_identifier is usually a UPI ID like 'paytmqr@paytm' or 'merchant@upi'.
- For card payments, payment_identifier is the merchant name.
- Extract date from SMS if present; otherwise use the receivedDate field provided.
- Extract time from SMS if present; otherwise use 00:00.
- amount must NOT include currency symbols — just digits and decimal point e.g. '500.00'.
- All string fields should be null (not the string "null") if not found.`;

/**
 * Parses a raw bank SMS using Claude Haiku.
 * @param {string} sender - SMS sender ID e.g. "BOBSMS"
 * @param {string} body - Full SMS body text
 * @param {string} receivedDate - ISO date string of when SMS was received
 * @returns {Promise<object>} Parsed transaction object
 */
async function parseSms(sender, body, receivedDate) {
  const userMessage = `Sender: ${sender}
Received: ${receivedDate}
SMS: ${body}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    output_config: {
      format: {
        type: "json_schema",
        schema: SMS_PARSE_SCHEMA
      }
    }
  });

  return JSON.parse(response.content[0].text);
}

module.exports = { parseSms };
