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

const SHEET_ID   = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "StockPrices";

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
// Mutual Fund CAGR
// ---------------------------------------------------------------------------

/**
 * Find a row in mfapi NAV history (newest-first) closest to targetDate.
 * Format: [{ date: "DD-MM-YYYY", nav: "123.45" }, ...]
 */
function findMfNav(navData, targetDate) {
  const target = targetDate.getTime();
  let best = null;
  let bestDiff = Infinity;
  for (const row of navData) {
    const [d, m, y] = row.date.split("-").map(Number);
    const t = new Date(y, m - 1, d).getTime();
    const diff = Math.abs(t - target);
    if (diff < bestDiff) { bestDiff = diff; best = row; }
  }
  return best ? parseFloat(best.nav) : null;
}

async function processMFs(isins) {
  const rows = [];
  const today       = new Date();
  const oneYrAgo    = new Date(today); oneYrAgo.setFullYear(today.getFullYear() - 1);
  const threeYrsAgo = new Date(today); threeYrsAgo.setFullYear(today.getFullYear() - 3);
  const fiveYrsAgo  = new Date(today); fiveYrsAgo.setFullYear(today.getFullYear() - 5);

  for (const isin of isins) {
    try {
      // Check for cached scheme_code first
      const cached = await pool.query(
        "SELECT scheme_code FROM asset_cagr WHERE isin = $1 AND asset_type = 'mf' LIMIT 1",
        [isin]
      );

      let schemeCode = cached.rows[0]?.scheme_code;

      if (!schemeCode) {
        const searchRes = await axios.get(
          `https://api.mfapi.in/mf/search?q=${encodeURIComponent(isin)}`,
          { timeout: 10000 }
        );
        const results = searchRes.data;
        if (!results || results.length === 0) {
          console.warn(`[CAGR/MF] No scheme found for ISIN ${isin} — skipping`);
          await sleep(300);
          continue;
        }
        schemeCode = String(results[0].schemeCode);
      }

      // Fetch full NAV history
      const navRes = await axios.get(
        `https://api.mfapi.in/mf/${schemeCode}`,
        { timeout: 15000 }
      );
      const navData = navRes.data?.data; // newest-first
      if (!navData || navData.length < 2) {
        console.warn(`[CAGR/MF] Insufficient NAV history for ${isin} — skipping`);
        await sleep(300);
        continue;
      }

      const latestNav = parseFloat(navData[0].nav);

      // Determine available history in years
      const [d, m, y] = navData[navData.length - 1].date.split("-").map(Number);
      const oldestDate = new Date(y, m - 1, d);
      const availYears = (today - oldestDate) / (365.25 * 24 * 3600 * 1000);

      // 1-year CAGR
      let cagr1y;
      if (availYears >= 1) {
        const nav1 = findMfNav(navData, oneYrAgo);
        cagr1y = computeCagr(nav1, latestNav, 1) ?? BENCHMARKS.mf;
      } else {
        cagr1y = BENCHMARKS.mf;
      }

      // 3-year CAGR
      let cagr3y;
      if (availYears >= 3) {
        const nav3 = findMfNav(navData, threeYrsAgo);
        cagr3y = computeCagr(nav3, latestNav, 3) ?? BENCHMARKS.mf;
      } else if (availYears >= 1) {
        const nav1 = findMfNav(navData, oneYrAgo);
        const raw = computeCagr(nav1, latestNav, Math.max(availYears, 1)) ?? BENCHMARKS.mf;
        cagr3y = blendWithBenchmark(raw, availYears, 3, BENCHMARKS.mf);
      } else {
        cagr3y = BENCHMARKS.mf;
      }

      // 5-year CAGR
      let cagr5y;
      if (availYears >= 5) {
        const nav5 = findMfNav(navData, fiveYrsAgo);
        cagr5y = computeCagr(nav5, latestNav, 5) ?? BENCHMARKS.mf;
      } else if (availYears >= 1) {
        const navOld = findMfNav(navData, fiveYrsAgo);
        const raw = computeCagr(navOld, latestNav, Math.max(availYears, 1)) ?? BENCHMARKS.mf;
        cagr5y = blendWithBenchmark(raw, availYears, 5, BENCHMARKS.mf);
      } else {
        cagr5y = BENCHMARKS.mf;
      }

      cagr1y = applyFloorAndCap(cagr1y, CAPS.mf);
      cagr3y = applyFloorAndCap(cagr3y, CAPS.mf);
      cagr5y = applyFloorAndCap(cagr5y, CAPS.mf);

      const mults = computeMultipliers(cagr1y, cagr3y, cagr5y);

      rows.push({
        symbol:      isin,
        asset_type:  "mf",
        exchange:    null,
        isin,
        scheme_code: schemeCode,
        category:    null,
        cagr_1y:     parseFloat(cagr1y.toFixed(4)),
        cagr_3y:     parseFloat(cagr3y.toFixed(4)),
        cagr_5y:     parseFloat(cagr5y.toFixed(4)),
        ...mults,
        cagr_source: "mfapi.in",
      });

      console.log(
        `[CAGR/MF] ${isin} (${schemeCode}) | ` +
        `1y:${(cagr1y * 100).toFixed(1)}% 3y:${(cagr3y * 100).toFixed(1)}% 5y:${(cagr5y * 100).toFixed(1)}%`
      );
    } catch (err) {
      console.error(`[CAGR/MF] Skipped ${isin}: ${err.message}`);
    }

    await sleep(300);
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

  // Only process symbols with stale (>7 days) or missing CAGR
  const staleResult = await pool.query(
    `SELECT s.tradingsymbol, s.exchange
     FROM unnest($1::text[], $2::text[]) AS s(tradingsymbol, exchange)
     LEFT JOIN asset_cagr ac ON ac.symbol = s.tradingsymbol AND ac.asset_type = 'stock'
     WHERE ac.last_updated_at IS NULL OR ac.last_updated_at < NOW() - INTERVAL '7 days'`,
    [stocks.map((s) => s.tradingsymbol), stocks.map((s) => s.exchange)]
  );

  const stale = staleResult.rows;
  if (stale.length === 0) {
    console.log("[CAGR/Sync] All stocks fresh (< 7 days) — skipping");
    return;
  }

  console.log(
    `[CAGR/Sync] Recomputing CAGR for ${stale.length} stale stock(s): ` +
    stale.map((s) => s.tradingsymbol).join(", ")
  );

  const rows = await processStocks(stale);
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
