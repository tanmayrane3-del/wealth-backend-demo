/**
 * Local test: verify recipient matching logic for SMS transactions.
 * Run with: node test-sms-match.js
 *
 * Tests both the pipe-split matching fix and Claude Haiku's payment_identifier output.
 */

require("dotenv").config();
const { parseSms } = require("./utils/smsParser");

// ── 1. Test pipe-split matching logic (no DB needed) ─────────────────────────

function matchesIdentifier(dbPaymentIdentifier, extracted) {
  // Simulates: LOWER($2) = ANY(string_to_array(LOWER(payment_identifier), '|'))
  const parts = dbPaymentIdentifier.toLowerCase().split("|");
  return parts.includes(extracted.toLowerCase());
}

const DB_IDENTIFIER = "ZOMATO|zomatoorder1.gpay@okpayaxis";

const testCases = [
  { extracted: "ZOMATO",                        expect: true  },
  { extracted: "zomato",                        expect: true  },
  { extracted: "zomatoorder1.gpay@okpayaxis",   expect: true  },
  { extracted: "Amazon",                        expect: false },
  { extracted: "ZOMATO|zomatoorder1",           expect: false }, // full string shouldn't match
];

console.log("── Pipe-split matching tests ──────────────────────────────");
let allPassed = true;
for (const { extracted, expect } of testCases) {
  const result = matchesIdentifier(DB_IDENTIFIER, extracted);
  const pass = result === expect;
  if (!pass) allPassed = false;
  console.log(`  ${pass ? "PASS" : "FAIL"}  extracted="${extracted}"  match=${result}  (expected ${expect})`);
}
console.log(allPassed ? "\nAll matching tests PASSED\n" : "\nSome tests FAILED\n");

// ── 2. Test Claude Haiku extraction ──────────────────────────────────────────

const SMS_SENDER = "ICICIB";
const SMS_BODY   = "INR 389.32 spent using ICICI Bank Card XX3009 on 19-Mar-26 on ZOMATO. Avl Limit: INR 4,63,490.81. If not you, call 1800 2662/SMS BLOCK 3009 to 9215676766.";
const RECEIVED   = new Date().toISOString();

console.log("── Claude Haiku extraction test ────────────────────────────");
console.log(`  SMS: ${SMS_BODY}\n`);

parseSms(SMS_SENDER, SMS_BODY, RECEIVED)
  .then((parsed) => {
    console.log("  Parsed result:");
    console.log(JSON.stringify(parsed, null, 4));

    console.log("\n── Match check against DB ──────────────────────────────────");
    if (parsed.payment_identifier) {
      const matched = matchesIdentifier(DB_IDENTIFIER, parsed.payment_identifier);
      console.log(`  payment_identifier = "${parsed.payment_identifier}"`);
      console.log(`  Matches DB entry   = ${matched}`);
      if (!matched) {
        console.log(`\n  DB stores: "${DB_IDENTIFIER}"`);
        console.log(`  Consider adding "${parsed.payment_identifier}" to the pipe-separated identifiers.`);
      }
    } else {
      console.log("  payment_identifier is null — no match possible");
    }
  })
  .catch((err) => {
    console.error("  Claude parse error:", err.message);
  });
