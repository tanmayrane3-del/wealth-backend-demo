const { google } = require("googleapis");

// Reuse the same singleton pattern as cagrCalculator.js
let _sheetsClient = null;
function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "{}");
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  _sheetsClient = google.sheets({ version: "v4", auth });
  return _sheetsClient;
}

const MACRO_RANGE = "MacroFactors!B2:B12";

// B2  → nifty_close
// B3  → nasdaq_close
// B4  → usd_inr
// B5  → hsi_close
// B6  → oil_brent
// B7  → dxy
// B8  → india_vix_high
// B9  → fii_net
// B10 → dii_net
// B11 → fed_rate
// B12 → rbi_rate
async function fetchMacroFactorsFromSheet() {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: MACRO_RANGE,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const values = res.data.values || [];

  const parseCell = (row) => {
    if (!row || row.length === 0) return null;
    const v = parseFloat(String(row[0]).replace(/,/g, ''));
    return isNaN(v) ? null : v;
  };

  return {
    nifty_close:    parseCell(values[0]),
    nasdaq_close:   parseCell(values[1]),
    usd_inr:        parseCell(values[2]),
    hsi_close:      parseCell(values[3]),
    oil_brent:      parseCell(values[4]),
    dxy:            parseCell(values[5]),
    india_vix_high: parseCell(values[6]),
    fii_net:        parseCell(values[7]),
    dii_net:        parseCell(values[8]),
    fed_rate:       parseCell(values[9]),
    rbi_rate:       parseCell(values[10]),
  };
}

module.exports = { fetchMacroFactorsFromSheet };
