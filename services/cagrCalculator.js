const cron    = require("node-cron");
const axios   = require("axios");
const pool    = require("../db");

// ---------------------------------------------------------------------------
// Config & Constants
// ---------------------------------------------------------------------------

// Alpha Vantage free tier: 5 requests/minute → 1 per 12 s to stay within limit
const RATE_LIMIT_MS = 12_000;
const AV_KEY = process.env.ALPHA_VANTAGE_KEY; // set in Render environment variables

// SEBI large-cap: top 100 stocks by market cap (Nifty 50 + Nifty Next 50)
const NIFTY100_SYMBOLS = new Set([
  // Nifty 50
  "ADANIPORTS","APOLLOHOSP","ASIANPAINT","AXISBANK","BAJAJ-AUTO","BAJFINANCE",
  "BAJAJFINSV","BEL","BPCL","BHARTIARTL","BRITANNIA","CIPLA","COALINDIA",
  "DRREDDY","EICHERMOT","GRASIM","HCLTECH","HDFCBANK","HDFCLIFE","HEROMOTOCO",
  "HINDALCO","HINDUNILVR","ICICIBANK","INDUSINDBK","INFY","IOC","ITC",
  "JSWSTEEL","KOTAKBANK","LT","M&M","MARUTI","NESTLEIND","NTPC","ONGC",
  "POWERGRID","RELIANCE","SBILIFE","SBIN","SHRIRAMFIN","SUNPHARMA","TATACONSUM",
  "TATAMOTORS","TATASTEEL","TCS","TECHM","TITAN","TRENT","ULTRACEMCO","WIPRO",
  // Nifty Next 50
  "ADANIENT","ADANIGREEN","AMBUJACEM","BANKBARODA","BHEL","BOSCHLTD","CANBK",
  "CHOLAFIN","COLPAL","DABUR","DLF","GAIL","GODREJCP","HAVELLS","ICICIGI",
  "ICICIPRULI","INDHOTEL","IRCTC","IRFC","LTIM","LUPIN","MOTHERSON","MUTHOOTFIN",
  "NHPC","NAUKRI","OFSS","OIL","PIIND","PNB","RECLTD","SIEMENS","SRF",
  "TORNTPHARM","TVSMOTOR","UNIONBANK","VEDL","VOLTAS","ZOMATO","ZYDUSLIFE",
]);

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


// metal_type (from metal_holdings table) → Stooq/NSE ETF ticker
const METAL_TICKERS = {
  physical_gold: "GOLDBEES.NS",
  digital_gold:  "GOLDBEES.NS",
  sgb:           "GOLDBEES.NS",
};

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
 * e.g. if we only have 2y of data for a 3y period:
 *   blended = calcCagr * (2/3) + benchmark * (1/3)
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

/**
 * Given a monthly-sorted array (oldest→newest) of { date, close } objects,
 * find the close price closest to `targetDate`.
 */
function findClosestPrice(history, targetDate) {
  if (!history || history.length === 0) return null;
  const target = targetDate.getTime();
  let best = history[0];
  let bestDiff = Math.abs(new Date(best.date).getTime() - target);
  for (const row of history) {
    const diff = Math.abs(new Date(row.date).getTime() - target);
    if (diff < bestDiff) { bestDiff = diff; best = row; }
  }
  return best?.close ?? best?.adjclose ?? null;
}

/**
 * Fetch monthly adjusted-close history from Alpha Vantage.
 * Accepts ".NS" tickers (NSE convention) and converts to ".NSE" for Alpha Vantage.
 * Returns array of { date: Date, close: number } sorted oldest→newest.
 * Requires ALPHA_VANTAGE_KEY env var.
 */
async function fetchAlphaVantageHistory(ticker, fromDate) {
  if (!AV_KEY) throw new Error("ALPHA_VANTAGE_KEY env var not set");

  // Convert .NS → .NSE (Alpha Vantage convention for NSE-listed instruments)
  const avSymbol = ticker.toUpperCase().endsWith(".NS")
    ? ticker.slice(0, -3) + ".NSE"
    : ticker.toUpperCase();

  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_MONTHLY_ADJUSTED&symbol=${encodeURIComponent(avSymbol)}&apikey=${AV_KEY}&outputsize=full`;

  const resp = await axios.get(url, { timeout: 20_000 });
  const data = resp.data;

  if (data["Information"]) throw new Error(`AV rate limit hit: ${data["Information"]}`);
  if (data["Error Message"]) throw new Error(`AV error: ${data["Error Message"]}`);
  if (data["Note"]) throw new Error(`AV note (rate limit): ${data["Note"]}`);

  const series = data["Monthly Adjusted Time Series"];
  if (!series || Object.keys(series).length === 0) {
    throw new Error(`No data returned for ${avSymbol}`);
  }

  const rows = [];
  for (const [dateStr, values] of Object.entries(series)) {
    const date = new Date(dateStr);
    if (date < fromDate) continue; // skip older than our 5-yr window
    const close = parseFloat(values["5. adjusted close"]);
    if (!isNaN(close) && close > 0) rows.push({ date, close });
  }

  rows.sort((a, b) => a.date - b.date); // oldest→newest
  if (rows.length < 2) throw new Error(`Insufficient history for ${avSymbol}`);
  return rows;
}

/**
 * Classify stock by symbol against Nifty 100 (no live API call needed).
 * Large cap = Nifty 100 member, otherwise mid-cap.
 */
function classifyBySymbol(tradingsymbol) {
  if (NIFTY100_SYMBOLS.has(tradingsymbol.toUpperCase())) {
    return { category: "LARGE_CAP", cap: CAPS.LARGE_CAP };
  }
  return { category: "MID_CAP", cap: CAPS.MID_CAP };
}

/**
 * Compute how many years of history are available in a monthly series.
 */
function availableYears(history) {
  if (!history || history.length < 2) return 0;
  const oldest = new Date(history[0].date).getTime();
  const newest = new Date(history[history.length - 1].date).getTime();
  return (newest - oldest) / (365.25 * 24 * 3600 * 1000);
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
    stocks: stocksRes.rows,                          // [{ tradingsymbol, exchange }]
    mfs:    mfsRes.rows.map((r) => r.isin),          // [isin_string]
    metals: metalsRes.rows.map((r) => r.metal_type), // [metal_type_string]
  };
}

// ---------------------------------------------------------------------------
// Stock CAGR
// ---------------------------------------------------------------------------

async function processStocks(stocks) {
  const rows = [];
  const today       = new Date();
  const fiveYrsAgo  = new Date(today); fiveYrsAgo.setFullYear(today.getFullYear() - 5);
  const oneYrAgo    = new Date(today); oneYrAgo.setFullYear(today.getFullYear() - 1);
  const threeYrsAgo = new Date(today); threeYrsAgo.setFullYear(today.getFullYear() - 3);

  // SGBs (exchange 'GB') don't trade on NSE — proxy via GOLDBEES.NS + 2.5% SGB interest bonus
  const isSgbStock  = (s) => s.exchange === "GB" || s.tradingsymbol.toUpperCase().startsWith("SGB");
  const sgbStocks     = stocks.filter(isSgbStock);
  const regularStocks = stocks.filter((s) => !isSgbStock(s));

  // --- SGB stocks ---
  if (sgbStocks.length > 0) {
    let goldHistory = null;
    try {
      goldHistory = await fetchAlphaVantageHistory("GOLDBEES.NS", fiveYrsAgo);
      console.log(`[CAGR/Stock-SGB] GOLDBEES.NS — ${goldHistory.length} monthly rows`);
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`[CAGR/Stock-SGB] Failed to fetch GOLDBEES.NS: ${err.message}`);
    }

    for (const { tradingsymbol, exchange } of sgbStocks) {
      if (!goldHistory) {
        console.warn(`[CAGR/Stock-SGB] Skipped ${tradingsymbol}: GOLDBEES.NS unavailable`);
        continue;
      }
      const availYrs   = availableYears(goldHistory);
      const latestP    = goldHistory.at(-1)?.close ?? goldHistory.at(-1)?.adjclose;
      const SGB_BONUS  = 0.025;

      let cagr1y, cagr3y, cagr5y;

      cagr1y = availYrs >= 1
        ? (computeCagr(findClosestPrice(goldHistory, oneYrAgo), latestP, 1) ?? BENCHMARKS.metal) + SGB_BONUS
        : BENCHMARKS.metal + SGB_BONUS;

      if (availYrs >= 3) {
        cagr3y = (computeCagr(findClosestPrice(goldHistory, threeYrsAgo), latestP, 3) ?? BENCHMARKS.metal) + SGB_BONUS;
      } else if (availYrs >= 1) {
        const raw = (computeCagr(findClosestPrice(goldHistory, oneYrAgo), latestP, Math.max(availYrs, 1)) ?? BENCHMARKS.metal) + SGB_BONUS;
        cagr3y = blendWithBenchmark(raw - SGB_BONUS, availYrs, 3, BENCHMARKS.metal) + SGB_BONUS;
      } else {
        cagr3y = BENCHMARKS.metal + SGB_BONUS;
      }

      if (availYrs >= 5) {
        cagr5y = (computeCagr(findClosestPrice(goldHistory, fiveYrsAgo), latestP, 5) ?? BENCHMARKS.metal) + SGB_BONUS;
      } else if (availYrs >= 1) {
        const raw = (computeCagr(findClosestPrice(goldHistory, fiveYrsAgo), latestP, Math.max(availYrs, 1)) ?? BENCHMARKS.metal) + SGB_BONUS;
        cagr5y = blendWithBenchmark(raw - SGB_BONUS, availYrs, 5, BENCHMARKS.metal) + SGB_BONUS;
      } else {
        cagr5y = BENCHMARKS.metal + SGB_BONUS;
      }

      cagr1y = applyFloorAndCap(cagr1y, CAPS.sgb);
      cagr3y = applyFloorAndCap(cagr3y, CAPS.sgb);
      cagr5y = applyFloorAndCap(cagr5y, CAPS.sgb);

      const mults = computeMultipliers(cagr1y, cagr3y, cagr5y);
      rows.push({
        symbol: tradingsymbol, asset_type: "stock", exchange, isin: null,
        scheme_code: null, category: "sgb",
        cagr_1y: parseFloat(cagr1y.toFixed(4)),
        cagr_3y: parseFloat(cagr3y.toFixed(4)),
        cagr_5y: parseFloat(cagr5y.toFixed(4)),
        ...mults, cagr_source: "alphavantage/GOLDBEES.NSE+2.5%",
      });
      console.log(
        `[CAGR/Stock-SGB] ${tradingsymbol} (+2.5%) | ` +
        `1y:${(cagr1y * 100).toFixed(1)}% 3y:${(cagr3y * 100).toFixed(1)}% 5y:${(cagr5y * 100).toFixed(1)}%`
      );
    }
  }

  // --- Regular stocks ---
  for (const { tradingsymbol, exchange } of regularStocks) {
    const ticker = `${tradingsymbol}.NS`;

    try {
      // Fetch 5-year monthly history from Stooq (no auth/crumb needed)
      const sorted = await fetchAlphaVantageHistory(ticker, fiveYrsAgo);

      // Classify by Nifty 100 membership instead of live market-cap lookup
      const { category, cap } = classifyBySymbol(tradingsymbol);
      const availYears = availableYears(sorted);
      const latestPrice = sorted.at(-1)?.close ?? sorted.at(-1)?.adjclose;

      // 1-year CAGR
      let cagr1y;
      if (availYears >= 1) {
        const p1 = findClosestPrice(sorted, oneYrAgo);
        cagr1y = computeCagr(p1, latestPrice, 1) ?? BENCHMARKS.stock;
      } else {
        cagr1y = BENCHMARKS.stock;
      }

      // 3-year CAGR
      let cagr3y;
      if (availYears >= 3) {
        const p3 = findClosestPrice(sorted, threeYrsAgo);
        cagr3y = computeCagr(p3, latestPrice, 3) ?? BENCHMARKS.stock;
      } else if (availYears >= 1) {
        const p1 = findClosestPrice(sorted, oneYrAgo);
        const raw = computeCagr(p1, latestPrice, availYears < 1 ? 1 : availYears) ?? BENCHMARKS.stock;
        cagr3y = blendWithBenchmark(raw, availYears, 3, BENCHMARKS.stock);
      } else {
        cagr3y = BENCHMARKS.stock;
      }

      // 5-year CAGR
      let cagr5y;
      if (availYears >= 5) {
        const p5 = findClosestPrice(sorted, fiveYrsAgo);
        cagr5y = computeCagr(p5, latestPrice, 5) ?? BENCHMARKS.stock;
      } else if (availYears >= 1) {
        const p = findClosestPrice(sorted, fiveYrsAgo);
        const raw = computeCagr(p, latestPrice, availYears < 1 ? 1 : availYears) ?? BENCHMARKS.stock;
        cagr5y = blendWithBenchmark(raw, availYears, 5, BENCHMARKS.stock);
      } else {
        cagr5y = BENCHMARKS.stock;
      }

      // Apply floor + ceiling
      cagr1y = applyFloorAndCap(cagr1y, cap);
      cagr3y = applyFloorAndCap(cagr3y, cap);
      cagr5y = applyFloorAndCap(cagr5y, cap);

      const mults = computeMultipliers(cagr1y, cagr3y, cagr5y);

      rows.push({
        symbol:       tradingsymbol,
        asset_type:   "stock",
        exchange,
        isin:         null,
        scheme_code:  null,
        category,
        cagr_1y:      parseFloat(cagr1y.toFixed(4)),
        cagr_3y:      parseFloat(cagr3y.toFixed(4)),
        cagr_5y:      parseFloat(cagr5y.toFixed(4)),
        ...mults,
        cagr_source:  "alphavantage",
      });

      console.log(
        `[CAGR/Stock] ${ticker} — ${category} | ` +
        `1y:${(cagr1y * 100).toFixed(1)}% 3y:${(cagr3y * 100).toFixed(1)}% 5y:${(cagr5y * 100).toFixed(1)}%`
      );
    } catch (err) {
      console.error(`[CAGR/Stock] Skipped ${ticker}: ${err.message}`);
    }

    await sleep(RATE_LIMIT_MS);
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
// Metal CAGR
// ---------------------------------------------------------------------------

async function processMetals(metalTypes) {
  const rows = [];

  // Filter to only known metal types
  const known = metalTypes.filter((mt) => METAL_TICKERS[mt]);
  const unknown = metalTypes.filter((mt) => !METAL_TICKERS[mt]);
  if (unknown.length > 0) {
    console.warn(`[CAGR/Metal] Unknown metal types (skipped): ${unknown.join(", ")}`);
  }
  if (known.length === 0) return rows;

  const today      = new Date();
  const fiveYrsAgo = new Date(today); fiveYrsAgo.setFullYear(today.getFullYear() - 5);
  const oneYrAgo   = new Date(today); oneYrAgo.setFullYear(today.getFullYear() - 1);
  const threeYrsAgo = new Date(today); threeYrsAgo.setFullYear(today.getFullYear() - 3);

  // All gold variants share GOLDBEES.NS — fetch once
  let goldHistory = null;
  let goldFetchErr = null;
  if (known.some((mt) => METAL_TICKERS[mt] === "GOLDBEES.NS")) {
    try {
      goldHistory = await fetchAlphaVantageHistory("GOLDBEES.NS", fiveYrsAgo);
      console.log(`[CAGR/Metal] GOLDBEES.NS history — ${goldHistory.length} monthly rows`);
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      goldFetchErr = err.message;
      console.error(`[CAGR/Metal] Failed to fetch GOLDBEES.NS: ${err.message}`);
    }
  }

  for (const metalType of known) {
    const ticker = METAL_TICKERS[metalType];
    const isSgb  = metalType === "sgb";
    const sorted = ticker === "GOLDBEES.NS" ? goldHistory : null;

    if (!sorted) {
      console.error(`[CAGR/Metal] No history for ${metalType} (${ticker}${goldFetchErr ? ": " + goldFetchErr : ""}) — skipping`);
      continue;
    }

    const availYears   = availableYears(sorted);
    const latestPrice  = sorted.at(-1)?.close ?? sorted.at(-1)?.adjclose;
    const cap          = isSgb ? CAPS.sgb : CAPS.metal;
    const sgbBonus     = isSgb ? 0.025 : 0;

    // 1-year CAGR
    let cagr1y;
    if (availYears >= 1) {
      const p = findClosestPrice(sorted, oneYrAgo);
      cagr1y = (computeCagr(p, latestPrice, 1) ?? BENCHMARKS.metal) + sgbBonus;
    } else {
      cagr1y = BENCHMARKS.metal + sgbBonus;
    }

    // 3-year CAGR
    let cagr3y;
    if (availYears >= 3) {
      const p = findClosestPrice(sorted, threeYrsAgo);
      cagr3y = (computeCagr(p, latestPrice, 3) ?? BENCHMARKS.metal) + sgbBonus;
    } else if (availYears >= 1) {
      const p = findClosestPrice(sorted, oneYrAgo);
      const raw = (computeCagr(p, latestPrice, Math.max(availYears, 1)) ?? BENCHMARKS.metal) + sgbBonus;
      cagr3y = blendWithBenchmark(raw - sgbBonus, availYears, 3, BENCHMARKS.metal) + sgbBonus;
    } else {
      cagr3y = BENCHMARKS.metal + sgbBonus;
    }

    // 5-year CAGR
    let cagr5y;
    if (availYears >= 5) {
      const p = findClosestPrice(sorted, fiveYrsAgo);
      cagr5y = (computeCagr(p, latestPrice, 5) ?? BENCHMARKS.metal) + sgbBonus;
    } else if (availYears >= 1) {
      const p = findClosestPrice(sorted, fiveYrsAgo);
      const raw = (computeCagr(p, latestPrice, Math.max(availYears, 1)) ?? BENCHMARKS.metal) + sgbBonus;
      cagr5y = blendWithBenchmark(raw - sgbBonus, availYears, 5, BENCHMARKS.metal) + sgbBonus;
    } else {
      cagr5y = BENCHMARKS.metal + sgbBonus;
    }

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
      cagr_source: "alphavantage/GOLDBEES.NSE",
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

  // Sequential processing to respect API rate limits
  const stockRows  = await processStocks(stocks);
  const mfRows     = await processMFs(mfs);
  const metalRows  = await processMetals(metals);

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
  // Sunday 11 PM IST = Sunday 17:30 UTC
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
 * Recomputes and upserts CAGR for all provided stocks.
 * Always overwrites existing rows — no "missing only" logic.
 * Safe to fire-and-forget.
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
// On-demand CAGR recompute for metals (called from sync-cagr endpoint)
// ---------------------------------------------------------------------------

/**
 * Recomputes and upserts CAGR for all provided metal types.
 * Always overwrites existing rows — no "missing only" logic.
 * @param {string[]} metalTypes  e.g. ["physical_gold", "digital_gold"]
 */
async function recomputeMetalsCagr(metalTypes) {
  if (!metalTypes || metalTypes.length === 0) return;

  console.log(
    `[CAGR/Sync] Recomputing CAGR for metals: ${metalTypes.join(", ")}`
  );

  const rows = await processMetals(metalTypes);
  if (rows.length > 0) await upsertCagrRows(rows);

  console.log(`[CAGR/Sync] Done — updated CAGR for ${rows.length} metal type(s)`);
}

// ---------------------------------------------------------------------------
// On-demand CAGR recompute for mutual funds (called from sync-cagr endpoint)
// ---------------------------------------------------------------------------

/**
 * Recomputes and upserts CAGR for all provided ISINs.
 * Always overwrites existing rows.
 * @param {string[]} isins  e.g. ["INF109K01AN1", "INF204K01AT7"]
 */
async function recomputeMfCagr(isins) {
  if (!isins || isins.length === 0) return;

  console.log(
    `[CAGR/Sync] Recomputing CAGR for ${isins.length} MF ISIN(s): ${isins.join(", ")}`
  );

  const rows = await processMFs(isins);
  if (rows.length > 0) await upsertCagrRows(rows);

  console.log(`[CAGR/Sync] Done — updated CAGR for ${rows.length} MF(s)`);
}

module.exports = { initCagrScheduler, runCagrJob, recomputeStocksCagr, recomputeMetalsCagr, recomputeMfCagr };
