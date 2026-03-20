const cron  = require("node-cron");
const axios  = require("axios");
const pool   = require("../db");
const { google } = require("googleapis");

// ---------------------------------------------------------------------------
// Google Sheets client (service-account auth)
// ---------------------------------------------------------------------------

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

const SHEET_ID      = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME    = "StockPrices";
const SHEET_NAME_MF = "MFNavs";

// ---------------------------------------------------------------------------
// Config & Constants
// ---------------------------------------------------------------------------

const CAPS = {
  LARGE_CAP: 0.25, // 25% ceiling for large-cap stocks
  MID_CAP:   0.35, // 35% ceiling for mid-cap stocks
  SMALL_CAP: 0.50, // 50% ceiling for small-cap stocks
  mf:        0.30, // 30% ceiling for mutual funds
  metal:     1.00, // no meaningful cap — gold CAGR is factual price history
  sgb:       1.025, // gold CAGR + 2.5% SGB interest, no cap
};

const BENCHMARKS = {
  stock: 0.12, // 12% blended benchmark for stocks with short history
  mf:    0.10, // 10% blended benchmark for MFs
  metal: 0.08, // 8%  blended benchmark for metals
};

// Static Nifty 100 classification (Nifty50 + Nifty Next50 = large cap, rest = mid cap)
// Avoids live market-cap lookups — updated manually when index rebalances.
const NIFTY50 = new Set([
  "ADANIENT","ADANIPORTS","APOLLOHOSP","ASIANPAINT","AXISBANK",
  "BAJAJ-AUTO","BAJFINANCE","BAJAJFINSV","BPCL","BHARTIARTL",
  "BRITANNIA","CIPLA","COALINDIA","DIVISLAB","DRREDDY",
  "EICHERMOT","GRASIM","HCLTECH","HDFCBANK","HDFCLIFE",
  "HEROMOTOCO","HINDALCO","HINDUNILVR","ICICIBANK","ITC",
  "INDUSINDBK","INFY","JSWSTEEL","KOTAKBANK","LT",
  "M&M","MARUTI","NESTLEIND","NTPC","ONGC",
  "POWERGRID","RELIANCE","SBILIFE","SBIN","SUNPHARMA",
  "TCS","TATACONSUM","TATAMOTORS","TATASTEEL","TECHM",
  "TITAN","ULTRACEMCO","WIPRO","UPL","VEDL",
]);

const NIFTY_NEXT50 = new Set([
  "ABB","ADANIGREEN","ADANITRANS","AMBUJACEM","AUROPHARMA",
  "BANDHANBNK","BANKBARODA","BERGEPAINT","BEL","BOSCHLTD",
  "CANBK","CHOLAFIN","COLPAL","CONCOR","CUMMINSIND",
  "DLF","DABUR","DMART","GAIL","GODREJCP",
  "GODREJPROP","HAVELLS","ICICIGI","ICICIPRULI","INDUSTOWER",
  "INDIGO","IOC","IRCTC","JSWENERGY","LTF",
  "LTIM","LUPIN","MCDOWELL-N","MFSL","MOTHERSON",
  "MPHASIS","MRF","NAUKRI","NMDC","OFSS",
  "PAGEIND","PIDILITIND","PIIND","PNB","RECLTD",
  "SAIL","SHRIRAMFIN","SIEMENS","TATAPOWER","TRENT",
]);

function classifyBySymbol(tradingsymbol) {
  const sym = tradingsymbol.toUpperCase();
  if (NIFTY50.has(sym) || NIFTY_NEXT50.has(sym)) {
    return { category: "LARGE_CAP", cap: CAPS.LARGE_CAP };
  }
  return { category: "MID_CAP", cap: CAPS.MID_CAP };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Compound Annual Growth Rate: (endPrice / startPrice)^(1/years) - 1
 */
function computeCagr(startPrice, endPrice, years) {
  if (!startPrice || startPrice <= 0 || !endPrice || endPrice <= 0 || years <= 0) return null;
  return Math.pow(endPrice / startPrice, 1 / years) - 1;
}

/**
 * When fewer years of history are available than the target period,
 * blend the calculated CAGR with a conservative benchmark.
 */
function blendWithBenchmark(cagr, availableYears, targetYears, benchmark) {
  if (availableYears >= targetYears) return cagr;
  const w = availableYears / targetYears;
  return cagr * w + benchmark * (1 - w);
}

/**
 * Clamp to [-1, cap]. Returns null if CAGR cannot be computed.
 */
function applyFloorAndCap(cagr, cap) {
  if (cagr == null || isNaN(cagr)) return null;
  return clamp(cagr, -1, cap);
}

/**
 * Projection multipliers: future_value = current_value * multiplier_Xy
 */
function computeMultipliers(cagr1y, cagr3y, cagr5y) {
  return {
    multiplier_1y: parseFloat(Math.pow(1 + cagr1y, 1).toFixed(6)),
    multiplier_3y: parseFloat(Math.pow(1 + cagr3y, 3).toFixed(6)),
    multiplier_5y: parseFloat(Math.pow(1 + cagr5y, 5).toFixed(6)),
  };
}

// ---------------------------------------------------------------------------
// Google Sheets helpers
// ---------------------------------------------------------------------------

/**
 * Ensures all symbols have a row in the StockPrices sheet.
 * Appends missing symbols with GOOGLEFINANCE formulas for 4 price points.
 */
async function syncSheetSymbols(symbols) {
  if (!SHEET_ID || symbols.length === 0) return;
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:A`,
  });
  const existing = (res.data.values || []).flat();

  const missing = symbols.filter((s) => !existing.includes(s));
  if (missing.length === 0) {
    console.log("[CAGR/Sheet] All symbols already in sheet");
    return;
  }

  console.log(`[CAGR/Sheet] Adding ${missing.length} new symbol(s): ${missing.join(", ")}`);

  const rows = missing.map((sym) => [
    sym,
    `=GOOGLEFINANCE("${sym}","price")`,
    `=IFERROR(INDEX(GOOGLEFINANCE("${sym}","price",TODAY()-366,TODAY()-359,"DAILY"),2,2),"")`,
    `=IFERROR(INDEX(GOOGLEFINANCE("${sym}","price",TODAY()-1097,TODAY()-1090,"DAILY"),2,2),"")`,
    `=IFERROR(INDEX(GOOGLEFINANCE("${sym}","price",TODAY()-1827,TODAY()-1820,"DAILY"),2,2),"")`,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:E`,
    valueInputOption: "USER_ENTERED",
    resource: { values: rows },
  });

  // Give Google time to evaluate the new formulas
  console.log("[CAGR/Sheet] Waiting 8s for formula evaluation…");
  await sleep(8_000);
}

/**
 * Reads columns A–E from the sheet and returns a price map.
 * Returns: { "NSE:HDFCBANK": { current, p1y, p3y, p5y }, ... }
 */
async function readSheetPrices(symbols) {
  if (!SHEET_ID || symbols.length === 0) return {};
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:E`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = res.data.values || [];
  const priceMap = {};

  for (const row of rows) {
    const sym = row[0];
    if (!symbols.includes(sym)) continue;
    priceMap[sym] = {
      current: parseFloat(row[1]) || null,
      p1y:     parseFloat(row[2]) || null,
      p3y:     parseFloat(row[3]) || null,
      p5y:     parseFloat(row[4]) || null,
    };
  }
  return priceMap;
}

// ---------------------------------------------------------------------------
// Symbol Collection
// ---------------------------------------------------------------------------

async function collectUniqueSymbols() {
  const [stocksRes, mfsRes, metalsRes] = await Promise.all([
    pool.query("SELECT DISTINCT tradingsymbol, exchange FROM stock_holdings"),
    pool.query("SELECT DISTINCT isin FROM mutual_fund_holdings WHERE isin IS NOT NULL AND isin <> ''"),
    pool.query("SELECT DISTINCT metal_type FROM metal_holdings"),
  ]);

  return {
    stocks: stocksRes.rows,
    mfs:    mfsRes.rows.map((r) => r.isin),
    metals: metalsRes.rows.map((r) => r.metal_type),
  };
}

// ---------------------------------------------------------------------------
// Stock CAGR
// ---------------------------------------------------------------------------

async function processStocks(stocks) {
  const rows = [];
  if (!SHEET_ID) {
    console.error("[CAGR/Stock] GOOGLE_SHEET_ID not set — skipping stocks");
    return rows;
  }
  if (stocks.length === 0) return rows;

  const isSgbStock    = (s) => s.exchange === "GB" || s.tradingsymbol.toUpperCase().startsWith("SGB");
  const sgbStocks     = stocks.filter(isSgbStock);
  const regularStocks = stocks.filter((s) => !isSgbStock(s));

  // Build the full symbol list needed in the sheet
  const regularSymbols = regularStocks.map((s) => `NSE:${s.tradingsymbol}`);
  const allSymbols = [...regularSymbols];
  if (sgbStocks.length > 0) allSymbols.push("NSE:GOLDBEES");

  await syncSheetSymbols(allSymbols);
  const priceMap = await readSheetPrices(allSymbols);

  // --- SGB stocks (GOLDBEES prices + 2.5% annual interest bonus) ---
  const goldPrices = priceMap["NSE:GOLDBEES"];
  for (const { tradingsymbol, exchange } of sgbStocks) {
    if (!goldPrices?.current) {
      console.warn(`[CAGR/Stock-SGB] Skipped ${tradingsymbol}: GOLDBEES price unavailable`);
      continue;
    }
    const SGB_BONUS = 0.025;
    let cagr1y = (computeCagr(goldPrices.p1y, goldPrices.current, 1) ?? BENCHMARKS.metal) + SGB_BONUS;
    let cagr3y = (computeCagr(goldPrices.p3y, goldPrices.current, 3) ?? blendWithBenchmark(cagr1y - SGB_BONUS, 1, 3, BENCHMARKS.metal)) + SGB_BONUS;
    let cagr5y = (computeCagr(goldPrices.p5y, goldPrices.current, 5) ?? blendWithBenchmark(cagr1y - SGB_BONUS, 1, 5, BENCHMARKS.metal)) + SGB_BONUS;
    cagr1y = applyFloorAndCap(cagr1y, CAPS.sgb);
    cagr3y = applyFloorAndCap(cagr3y, CAPS.sgb);
    cagr5y = applyFloorAndCap(cagr5y, CAPS.sgb);
    rows.push({
      symbol: tradingsymbol, asset_type: "stock", exchange, isin: null,
      scheme_code: null, category: "sgb",
      cagr_1y: parseFloat(cagr1y.toFixed(4)),
      cagr_3y: parseFloat(cagr3y.toFixed(4)),
      cagr_5y: parseFloat(cagr5y.toFixed(4)),
      ...computeMultipliers(cagr1y, cagr3y, cagr5y),
      cagr_source: "google-sheets/GOOGLEFINANCE+2.5%",
    });
    console.log(
      `[CAGR/Stock-SGB] ${tradingsymbol} (+2.5%) | ` +
      `1y:${(cagr1y * 100).toFixed(1)}% 3y:${(cagr3y * 100).toFixed(1)}% 5y:${(cagr5y * 100).toFixed(1)}%`
    );
  }

  // --- Regular stocks ---
  for (const { tradingsymbol, exchange } of regularStocks) {
    const sym    = `NSE:${tradingsymbol}`;
    const prices = priceMap[sym];
    if (!prices?.current) {
      console.warn(`[CAGR/Stock] Skipped ${sym}: no price data in sheet`);
      continue;
    }

    const { category, cap } = classifyBySymbol(tradingsymbol);

    let cagr1y = computeCagr(prices.p1y, prices.current, 1) ?? BENCHMARKS.stock;
    let cagr3y = prices.p3y
      ? (computeCagr(prices.p3y, prices.current, 3) ?? blendWithBenchmark(cagr1y, 1, 3, BENCHMARKS.stock))
      : blendWithBenchmark(cagr1y, 1, 3, BENCHMARKS.stock);
    let cagr5y = prices.p5y
      ? (computeCagr(prices.p5y, prices.current, 5) ?? blendWithBenchmark(cagr1y, 1, 5, BENCHMARKS.stock))
      : blendWithBenchmark(cagr1y, 1, 5, BENCHMARKS.stock);

    cagr1y = applyFloorAndCap(cagr1y, cap);
    cagr3y = applyFloorAndCap(cagr3y, cap);
    cagr5y = applyFloorAndCap(cagr5y, cap);

    rows.push({
      symbol: tradingsymbol, asset_type: "stock", exchange, isin: null,
      scheme_code: null, category,
      cagr_1y: parseFloat(cagr1y.toFixed(4)),
      cagr_3y: parseFloat(cagr3y.toFixed(4)),
      cagr_5y: parseFloat(cagr5y.toFixed(4)),
      ...computeMultipliers(cagr1y, cagr3y, cagr5y),
      cagr_source: "google-sheets/GOOGLEFINANCE",
    });
    console.log(
      `[CAGR/Stock] ${sym} — ${category} | ` +
      `1y:${(cagr1y * 100).toFixed(1)}% 3y:${(cagr3y * 100).toFixed(1)}% 5y:${(cagr5y * 100).toFixed(1)}%`
    );
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Mutual Fund CAGR  (Google Sheets-based — same pattern as stocks)
// ---------------------------------------------------------------------------

/**
 * Ensures all ISINs have a row in the MFNavs sheet (columns A–F):
 *   A: ISIN | B: scheme_code | C: nav_current | D: nav_1y | E: nav_3y | F: nav_5y
 *
 * The backend only writes A & B.  Columns C–F are filled by a Google Apps Script
 * that runs from Google's servers (no Render IP block) and calls mfapi.in.
 * Returns { [isin]: scheme_code } for all ISINs that have a scheme_code in the DB.
 */
async function syncMfSheetIsins(isins) {
  if (!SHEET_ID || isins.length === 0) return {};

  // Resolve scheme_codes from DB (set at CAS import via AMFI lookup)
  const result = await pool.query(
    `SELECT DISTINCT isin, scheme_code FROM mutual_fund_holdings
     WHERE isin = ANY($1) AND scheme_code IS NOT NULL`,
    [isins]
  );
  const isinToScheme = {};
  for (const row of result.rows) isinToScheme[row.isin] = row.scheme_code;

  const sheets = getSheetsClient();

  // Read existing ISINs already in the sheet
  let existingIsins = [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME_MF}!A:A`,
    });
    existingIsins = (res.data.values || []).flat().filter((v) => v && v !== "ISIN");
  } catch { /* sheet might not exist yet — append will create it */ }

  const missing = isins.filter((isin) => !existingIsins.includes(isin) && isinToScheme[isin]);
  if (missing.length === 0) {
    console.log("[CAGR/MF-Sheet] All ISINs already in sheet");
    return isinToScheme;
  }

  const rows = [];
  if (existingIsins.length === 0) {
    rows.push(["ISIN", "scheme_code", "nav_current", "nav_1y", "nav_3y", "nav_5y"]);
  }
  for (const isin of missing) {
    rows.push([isin, isinToScheme[isin], "", "", "", ""]);
  }

  console.log(`[CAGR/MF-Sheet] Adding ${missing.length} new ISIN(s): ${missing.join(", ")}`);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME_MF}!A:F`,
    valueInputOption: "RAW",
    resource: { values: rows },
  });

  return isinToScheme;
}

/**
 * Reads NAV history from the MFNavs sheet (populated by Apps Script).
 * Returns { [isin]: { current, p1y, p3y, p5y, scheme_code } }
 */
async function readMfNavsFromSheet(isins) {
  if (!SHEET_ID || isins.length === 0) return {};
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME_MF}!A:F`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows    = res.data.values || [];
  const isinSet = new Set(isins);
  const navMap  = {};

  for (const row of rows) {
    const isin = String(row[0] || "").trim();
    if (!isin || isin === "ISIN" || !isinSet.has(isin)) continue;

    const current = parseFloat(row[2]) || null;
    if (!current) continue; // Apps Script hasn't populated this ISIN yet

    navMap[isin] = {
      current,
      p1y:         parseFloat(row[3]) || null,
      p3y:         parseFloat(row[4]) || null,
      p5y:         parseFloat(row[5]) || null,
      scheme_code: String(row[1] || ""),
    };
  }

  return navMap;
}

/**
 * processMFs — same pattern as processStocks:
 *   1. Ensure ISINs are in MFNavs sheet (write A & B)
 *   2. Read NAV history from sheet (filled by Apps Script)
 *   3. Compute CAGR and return rows for upsert
 */
async function processMFs(isins) {
  const rows = [];

  if (!SHEET_ID) {
    console.error("[CAGR/MF] GOOGLE_SHEET_ID not set — skipping MFs");
    return rows;
  }
  if (isins.length === 0) return rows;

  await syncMfSheetIsins(isins);
  const navMap = await readMfNavsFromSheet(isins);

  for (const isin of isins) {
    const navs = navMap[isin];
    if (!navs?.current) {
      console.warn(`[CAGR/MF] ${isin}: no NAV data in sheet yet — run Apps Script then retry`);
      continue;
    }

    const { current, p1y, p3y, p5y, scheme_code } = navs;

    // Identical CAGR logic to processStocks
    let cagr1y = p1y
      ? (computeCagr(p1y, current, 1) ?? BENCHMARKS.mf)
      : BENCHMARKS.mf;

    let cagr3y = p3y
      ? (computeCagr(p3y, current, 3) ?? blendWithBenchmark(cagr1y, 1, 3, BENCHMARKS.mf))
      : blendWithBenchmark(cagr1y, 1, 3, BENCHMARKS.mf);

    let cagr5y = p5y
      ? (computeCagr(p5y, current, 5) ?? blendWithBenchmark(cagr1y, 1, 5, BENCHMARKS.mf))
      : blendWithBenchmark(cagr1y, 1, 5, BENCHMARKS.mf);

    cagr1y = applyFloorAndCap(cagr1y, CAPS.mf);
    cagr3y = applyFloorAndCap(cagr3y, CAPS.mf);
    cagr5y = applyFloorAndCap(cagr5y, CAPS.mf);

    rows.push({
      symbol:      isin,
      asset_type:  "mf",
      exchange:    null,
      isin,
      scheme_code,
      category:    null,
      cagr_1y:     parseFloat(cagr1y.toFixed(4)),
      cagr_3y:     parseFloat(cagr3y.toFixed(4)),
      cagr_5y:     parseFloat(cagr5y.toFixed(4)),
      ...computeMultipliers(cagr1y, cagr3y, cagr5y),
      cagr_source: "google-sheets/mfapi.in",
    });

    console.log(
      `[CAGR/MF] ${isin} (${scheme_code}) via sheet | ` +
      `1y:${(cagr1y * 100).toFixed(1)}% 3y:${(cagr3y * 100).toFixed(1)}% 5y:${(cagr5y * 100).toFixed(1)}%`
    );
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Metal CAGR  (uses GOLDBEES from the same Google Sheet)
// ---------------------------------------------------------------------------

async function processMetals(metalTypes) {
  const rows = [];
  if (!SHEET_ID) {
    console.error("[CAGR/Metal] GOOGLE_SHEET_ID not set — skipping metals");
    return rows;
  }

  const KNOWN_METAL_TYPES = new Set(["physical_gold", "digital_gold", "sgb"]);
  const known   = metalTypes.filter((mt) => KNOWN_METAL_TYPES.has(mt));
  const unknown = metalTypes.filter((mt) => !KNOWN_METAL_TYPES.has(mt));
  if (unknown.length > 0) {
    console.warn(`[CAGR/Metal] Unknown metal types (skipped): ${unknown.join(", ")}`);
  }
  if (known.length === 0) return rows;

  await syncSheetSymbols(["NSE:GOLDBEES"]);
  const priceMap = await readSheetPrices(["NSE:GOLDBEES"]);
  const goldPrices = priceMap["NSE:GOLDBEES"];

  if (!goldPrices?.current) {
    console.error("[CAGR/Metal] GOLDBEES price unavailable — skipping all metals");
    return rows;
  }

  console.log(
    `[CAGR/Metal] GOLDBEES prices — current:${goldPrices.current} ` +
    `1y:${goldPrices.p1y} 3y:${goldPrices.p3y} 5y:${goldPrices.p5y}`
  );

  for (const metalType of known) {
    const isSgb    = metalType === "sgb";
    const cap      = isSgb ? CAPS.sgb : CAPS.metal;
    const sgbBonus = isSgb ? 0.025 : 0;

    let cagr1y = (computeCagr(goldPrices.p1y, goldPrices.current, 1) ?? BENCHMARKS.metal) + sgbBonus;
    let cagr3y = (computeCagr(goldPrices.p3y, goldPrices.current, 3) ?? blendWithBenchmark(cagr1y - sgbBonus, 1, 3, BENCHMARKS.metal)) + sgbBonus;
    let cagr5y = (computeCagr(goldPrices.p5y, goldPrices.current, 5) ?? blendWithBenchmark(cagr1y - sgbBonus, 1, 5, BENCHMARKS.metal)) + sgbBonus;

    cagr1y = applyFloorAndCap(cagr1y, cap);
    cagr3y = applyFloorAndCap(cagr3y, cap);
    cagr5y = applyFloorAndCap(cagr5y, cap);

    const mults = computeMultipliers(cagr1y, cagr3y, cagr5y);

    rows.push({
      symbol:      metalType,
      asset_type:  "metal",
      exchange:    null,
      isin:        null,
      scheme_code: null,
      category:    isSgb ? "sgb" : "gold",
      cagr_1y:     parseFloat(cagr1y.toFixed(4)),
      cagr_3y:     parseFloat(cagr3y.toFixed(4)),
      cagr_5y:     parseFloat(cagr5y.toFixed(4)),
      ...mults,
      cagr_source: "google-sheets/GOOGLEFINANCE" + (isSgb ? "+2.5%" : ""),
    });

    console.log(
      `[CAGR/Metal] ${metalType}${isSgb ? " (+2.5% SGB bonus)" : ""} | ` +
      `1y:${(cagr1y * 100).toFixed(1)}% 3y:${(cagr3y * 100).toFixed(1)}% 5y:${(cagr5y * 100).toFixed(1)}%`
    );
  }

  return rows;
}

// ---------------------------------------------------------------------------
// DB Upsert
// ---------------------------------------------------------------------------

async function upsertCagrRows(rows) {
  let upserted = 0;
  for (const row of rows) {
    try {
      await pool.query(
        `INSERT INTO asset_cagr
           (symbol, asset_type, exchange, isin, scheme_code, category,
            cagr_1y, cagr_3y, cagr_5y,
            multiplier_1y, multiplier_3y, multiplier_5y,
            cagr_source, last_updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT (symbol, asset_type)
         DO UPDATE SET
           exchange      = EXCLUDED.exchange,
           category      = EXCLUDED.category,
           scheme_code   = COALESCE(EXCLUDED.scheme_code, asset_cagr.scheme_code),
           cagr_1y       = EXCLUDED.cagr_1y,
           cagr_3y       = EXCLUDED.cagr_3y,
           cagr_5y       = EXCLUDED.cagr_5y,
           multiplier_1y = EXCLUDED.multiplier_1y,
           multiplier_3y = EXCLUDED.multiplier_3y,
           multiplier_5y = EXCLUDED.multiplier_5y,
           cagr_source   = EXCLUDED.cagr_source,
           last_updated_at = NOW()`,
        [
          row.symbol, row.asset_type, row.exchange, row.isin, row.scheme_code, row.category,
          row.cagr_1y, row.cagr_3y, row.cagr_5y,
          row.multiplier_1y, row.multiplier_3y, row.multiplier_5y,
          row.cagr_source,
        ]
      );
      upserted++;
    } catch (err) {
      console.error(`[CAGR/DB] Upsert failed for ${row.symbol} (${row.asset_type}): ${err.message}`);
    }
  }
  console.log(`[CAGR/DB] Upserted ${upserted}/${rows.length} rows`);
}

// ---------------------------------------------------------------------------
// Main Job Runner
// ---------------------------------------------------------------------------

async function runCagrJob() {
  console.log("[CAGR] Job started");
  const start = Date.now();

  const { stocks, mfs, metals } = await collectUniqueSymbols();
  console.log(
    `[CAGR] Symbols collected — stocks:${stocks.length}, mfs:${mfs.length}, metals:${metals.length}`
  );

  const stockRows = await processStocks(stocks);
  const mfRows    = await processMFs(mfs);
  const metalRows = await processMetals(metals);

  const allRows = [...stockRows, ...mfRows, ...metalRows];
  await upsertCagrRows(allRows);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `[CAGR] Job complete in ${elapsed}s — updated:${allRows.length} ` +
    `(stocks:${stockRows.length}, mfs:${mfRows.length}, metals:${metalRows.length})`
  );

  return {
    updated: allRows.length,
    stocks:  stockRows.length,
    mfs:     mfRows.length,
    metals:  metalRows.length,
    elapsed_seconds: parseFloat(elapsed),
  };
}

// ---------------------------------------------------------------------------
// Scheduler Initializer
// ---------------------------------------------------------------------------

/**
 * Registers a weekly cron job — every Sunday at 23:00 IST (17:30 UTC).
 * Call this once from index.js after app.listen().
 */
function initCagrScheduler() {
  cron.schedule("30 17 * * 0", async () => {
    console.log("[CAGR] Weekly cron triggered");
    try {
      await runCagrJob();
    } catch (err) {
      console.error("[CAGR] Weekly job failed:", err.message);
    }
  });

  console.log("[CAGR] Weekly scheduler initialized — runs Sunday 23:00 IST (17:30 UTC)");
}

// ---------------------------------------------------------------------------
// On-demand CAGR recompute (called after manual holdings sync)
// ---------------------------------------------------------------------------

/**
 * Recomputes CAGR only for stocks whose data is older than 7 days.
 * Safe to fire-and-forget. Scales to any number of users.
 * @param {Array<{tradingsymbol: string, exchange: string}>} stocks
 */
async function recomputeStocksCagr(stocks) {
  if (!stocks || stocks.length === 0) return;

  console.log(
    `[CAGR/Sync] Recomputing CAGR for ${stocks.length} stock(s): ` +
    stocks.map((s) => s.tradingsymbol).join(", ")
  );

  const rows = await processStocks(stocks);
  if (rows.length > 0) await upsertCagrRows(rows);

  console.log(`[CAGR/Sync] Done — updated CAGR for ${rows.length} stock(s)`);
}

// ---------------------------------------------------------------------------
// On-demand CAGR recompute for metals
// ---------------------------------------------------------------------------

/**
 * Recomputes and upserts CAGR for all provided metal types.
 * @param {string[]} metalTypes  e.g. ["physical_gold", "digital_gold"]
 */
async function recomputeMetalsCagr(metalTypes) {
  if (!metalTypes || metalTypes.length === 0) return;

  console.log(`[CAGR/Sync] Recomputing CAGR for metals: ${metalTypes.join(", ")}`);

  const rows = await processMetals(metalTypes);
  if (rows.length > 0) await upsertCagrRows(rows);

  console.log(`[CAGR/Sync] Done — updated CAGR for ${rows.length} metal type(s)`);
}

// ---------------------------------------------------------------------------
// On-demand CAGR recompute for mutual funds
// ---------------------------------------------------------------------------

/**
 * Recomputes and upserts CAGR for all provided ISINs.
 * @param {string[]} isins  e.g. ["INF109K01AN1", "INF204K01AT7"]
 */
async function recomputeMfCagr(isins) {
  if (!isins || isins.length === 0) return;

  console.log(`[CAGR/Sync] Recomputing CAGR for ${isins.length} MF ISIN(s): ${isins.join(", ")}`);

  const rows = await processMFs(isins);
  if (rows.length > 0) await upsertCagrRows(rows);

  console.log(`[CAGR/Sync] Done — updated CAGR for ${rows.length} MF(s)`);
}

module.exports = { initCagrScheduler, runCagrJob, recomputeStocksCagr, recomputeMetalsCagr, recomputeMfCagr };
