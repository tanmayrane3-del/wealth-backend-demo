const pool    = require("../db");
const axios   = require("axios");
const pdfParse = require("pdf-parse");
const { success, fail }     = require("../utils/respond");
const { recomputeMfCagr }   = require("../services/cagrCalculator");

const MFAPI_BASE = "https://api.mfapi.in/mf";

// ---------------------------------------------------------------------------
// XIRR (Newton-Raphson)
// ---------------------------------------------------------------------------

/**
 * cashFlows: [{date: Date, amount: number}]
 * Negative amounts = purchases; final positive amount = current value.
 * Returns decimal rate (e.g. 0.185 = 18.5%) or null if non-convergent.
 */
function xirr(cashFlows, guess = 0.1) {
  if (!cashFlows || cashFlows.length < 2) return null;

  const t0    = cashFlows[0].date.getTime();
  const years = cashFlows.map((cf) => (cf.date.getTime() - t0) / (365.25 * 86400000));

  // Guard: all purchase dates identical → XIRR undefined
  const maxT = Math.max(...years);
  if (maxT < 0.003) return null; // < ~1 day difference

  let rate = guess;
  for (let i = 0; i < 100; i++) {
    let f = 0, df = 0;
    for (let j = 0; j < cashFlows.length; j++) {
      const base = Math.pow(1 + rate, years[j]);
      const pv   = cashFlows[j].amount / base;
      f  += pv;
      df -= years[j] * cashFlows[j].amount / (base * (1 + rate));
    }
    if (df === 0) return null;
    const newRate = rate - f / df;
    if (Math.abs(newRate - rate) < 1e-6) {
      const result = parseFloat(newRate.toFixed(6));
      // Sanity clamp: XIRR outside [-99%, 500%] → likely bad data
      return result >= -0.99 && result <= 5.0 ? result : null;
    }
    rate = Math.max(-0.999, Math.min(100, newRate));
  }
  return null; // did not converge
}

function computeXirr(lots, currentValue) {
  try {
    const sorted = [...lots].sort((a, b) => new Date(a.purchase_date) - new Date(b.purchase_date));
    const cashFlows = sorted.map((lot) => ({
      date:   new Date(lot.purchase_date),
      amount: -Math.abs(parseFloat(lot.amount_invested)),
    }));
    cashFlows.push({ date: new Date(), amount: currentValue });
    return xirr(cashFlows);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// NAV cache helper
// ---------------------------------------------------------------------------

/**
 * Returns { latest_nav, nav_date } for a given scheme_code.
 * Checks mutual_fund_nav_cache first (4-hour TTL), then fetches from mfapi.in.
 * Returns null if unavailable.
 */
async function getNavForScheme(schemeCode) {
  if (!schemeCode) return null;

  // Check cache
  const cached = await pool.query(
    `SELECT latest_nav, nav_date FROM mutual_fund_nav_cache
     WHERE scheme_code = $1 AND fetched_at > NOW() - INTERVAL '4 hours'`,
    [schemeCode]
  );
  if (cached.rows.length > 0) {
    return {
      latest_nav: parseFloat(cached.rows[0].latest_nav),
      nav_date:   cached.rows[0].nav_date?.toISOString?.()?.slice(0, 10) ?? String(cached.rows[0].nav_date),
    };
  }

  // Fetch fresh
  try {
    const res = await axios.get(`${MFAPI_BASE}/${schemeCode}`, { timeout: 8000 });
    const meta    = res.data?.meta;
    const navData = res.data?.data;
    if (!navData || navData.length === 0) return null;

    const latest_nav  = parseFloat(navData[0].nav);
    const nav_date    = parseIndianDate(navData[0].date);
    const scheme_name = meta?.scheme_name ?? null;
    const amc_name    = meta?.fund_house  ?? null;
    const isin        = meta?.isin_growth ?? null;

    // Upsert cache
    await pool.query(
      `INSERT INTO mutual_fund_nav_cache (scheme_code, isin, scheme_name, amc_name, latest_nav, nav_date, source, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'mfapi.in', NOW())
       ON CONFLICT (scheme_code) DO UPDATE
         SET latest_nav = EXCLUDED.latest_nav,
             nav_date   = EXCLUDED.nav_date,
             fetched_at = NOW()`,
      [schemeCode, isin, scheme_name, amc_name, latest_nav, nav_date]
    );

    return { latest_nav, nav_date };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const MONTH_MAP = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };

/** DD-MMM-YYYY → YYYY-MM-DD */
function parseIndianDate(s) {
  if (!s) return null;
  const parts = s.split("-");
  if (parts.length !== 3) return s;
  const [d, m, y] = parts;
  const mo = MONTH_MAP[m.toUpperCase()];
  if (mo === undefined) return s;
  return `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Strip commas and parse float */
const parseNum = (s) => parseFloat(String(s).replace(/,/g, ""));

// ---------------------------------------------------------------------------
// GET /api/mutual-funds/lookup?isin=XX
// ---------------------------------------------------------------------------

const lookupScheme = async (req, res) => {
  const { isin } = req.query;
  if (!isin || !/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin.trim().toUpperCase())) {
    return fail(res, "Invalid ISIN format");
  }

  try {
    const searchRes = await axios.get(
      `${MFAPI_BASE}/search?isin=${encodeURIComponent(isin.trim().toUpperCase())}`,
      { timeout: 8000 }
    );
    const results = searchRes.data;
    if (!Array.isArray(results) || results.length === 0) {
      return fail(res, "Scheme not found for this ISIN", 404);
    }
    const schemeCode = String(results[0].schemeCode);
    const schemeName = results[0].schemeName ?? null;

    // Try to get more meta from the scheme detail endpoint
    let amcName = null;
    try {
      const detailRes = await axios.get(`${MFAPI_BASE}/${schemeCode}`, { timeout: 8000 });
      amcName = detailRes.data?.meta?.fund_house ?? null;
    } catch { /* ignore */ }

    return success(res, { scheme_code: schemeCode, scheme_name: schemeName, amc_name: amcName });
  } catch (err) {
    console.error("[mf/lookup] Error:", err.message);
    return fail(res, "Failed to look up scheme: " + err.message, 500);
  }
};

// ---------------------------------------------------------------------------
// POST /api/mutual-funds/cas/upload  (parse only — no DB write)
// ---------------------------------------------------------------------------

const parseCasPdf = async (req, res) => {
  if (!req.file) return fail(res, "No PDF file uploaded");

  let text;
  try {
    const parsed = await pdfParse(req.file.buffer);
    text = parsed.text;
  } catch (err) {
    return fail(res, "Failed to parse PDF: " + err.message, 400);
  }

  try {
    const funds = await extractFundsFromCas(text);
    const nonZero = funds.filter((f) => f.closing_units > 0.0009);

    if (nonZero.length === 0) {
      return fail(res, "No active holdings found in this CAS");
    }

    return success(res, { funds: nonZero, total_funds: nonZero.length });
  } catch (err) {
    console.error("[mf/cas-upload] Parse error:", err.message);
    return fail(res, "Error extracting holdings: " + err.message, 422);
  }
};

async function extractFundsFromCas(text) {
  // Split on "Folio No :" boundary — block[0] is the header preamble
  const blocks = text.split(/Folio No\s*:/i);

  const funds = [];

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];

    // --- Folio number: first non-empty token(s) up to newline
    const folioLine = block.split("\n")[0].trim();
    const folioNumber = folioLine.split(/\s+/).slice(0, 2).join("").trim() || "UNKNOWN";

    // --- ISIN
    const isinMatch = block.match(/ISIN[:\s]+([A-Z]{2}[A-Z0-9]{10})/);
    if (!isinMatch) continue;
    const isin = isinMatch[1];

    // --- AMC name: from the last non-empty line in the PREVIOUS preamble block
    let amcName = null;
    if (i === 1) {
      // First fund — AMC is in the header preamble (block[0])
      const prevLines = blocks[0].split("\n").map((l) => l.trim()).filter(Boolean);
      amcName = prevLines[prevLines.length - 1] ?? null;
    } else {
      // AMC is the last non-empty line before "Folio No" in the previous block
      const prevBlock = blocks[i - 1];
      const prevLines = prevBlock.split("\n").map((l) => l.trim()).filter(Boolean);
      amcName = prevLines[prevLines.length - 1] ?? null;
    }
    // Sanitize: skip if it looks like a transaction line
    if (amcName && /^\d{2}-[A-Z]{3}-\d{4}/.test(amcName)) amcName = null;

    // --- Closing balance line (may be split across lines in PDF extraction)
    // Join every pair of consecutive lines to handle splitting
    const lines = block.split("\n");
    let closingLine = null;
    for (let j = 0; j < lines.length; j++) {
      const joined = lines.slice(j, j + 4).join(" ");
      if (/Closing Unit Balance/i.test(joined)) {
        closingLine = joined;
        break;
      }
    }

    let closingUnits = 0;
    let navAtStatement = 0;
    let costValue = 0;

    if (closingLine) {
      const cuMatch  = closingLine.match(/Closing Unit Balance:\s*([\d,]+\.?\d*)/i);
      const navMatch = closingLine.match(/NAV on [^:]+:\s*INR\s*([\d,]+\.?\d*)/i);
      const cvMatch  = closingLine.match(/Total Cost Value\s*:\s*INR\s*([\d,]+\.?\d*)/i);
      if (cuMatch)  closingUnits    = parseNum(cuMatch[1]);
      if (navMatch) navAtStatement  = parseNum(navMatch[1]);
      if (cvMatch)  costValue       = parseNum(cvMatch[1]);
    }

    // --- Scheme name: look for line containing the ISIN (usually "SchemeName - Growth Option   ISIN:XXXXX")
    let schemeName = isin; // fallback
    for (const line of lines) {
      if (line.includes(isin)) {
        // Scheme name is everything before "ISIN"
        const beforeIsin = line.split(/ISIN/i)[0].trim().replace(/[-\s]+$/, "").trim();
        if (beforeIsin.length > 5) { schemeName = beforeIsin; break; }
      }
    }

    // --- Transaction lots (Purchase, Additional Purchase, SIP only)
    const lots = [];
    const TXN_RE = /^(\d{2}-[A-Z]{3}-\d{4})\s+(Purchase|Additional\s+Purchase|SIP)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)/i;

    for (const line of lines) {
      if (/\*{3}/.test(line)) continue; // skip stamp duty / STT lines
      if (/\([\d,]+\.?\d*\)/.test(line)) continue; // skip redemptions (neg in parentheses)

      const m = line.trim().match(TXN_RE);
      if (!m) continue;

      const date   = parseIndianDate(m[1]);
      const amount = parseNum(m[3]);
      const units  = parseNum(m[4]);
      const nav    = parseNum(m[5]);

      if (!date || isNaN(amount) || isNaN(units) || isNaN(nav)) continue;
      if (amount <= 0 || units <= 0) continue;

      lots.push({ date, units, nav, amount });
    }

    funds.push({
      isin,
      scheme_code:    null, // resolved below
      scheme_name:    schemeName,
      amc_name:       amcName,
      folio_number:   folioNumber,
      closing_units:  closingUnits,
      nav_at_statement: navAtStatement,
      amount_invested:  costValue || lots.reduce((s, l) => s + l.amount, 0),
      lookup_failed:  false,
      lots,
    });
  }

  // Resolve scheme_codes in parallel batches of 5
  const isins = [...new Set(funds.map((f) => f.isin))];
  const schemeMap = {};

  for (let i = 0; i < isins.length; i += 5) {
    const batch = isins.slice(i, i + 5);
    await Promise.all(
      batch.map(async (isin) => {
        try {
          const r = await axios.get(
            `${MFAPI_BASE}/search?isin=${encodeURIComponent(isin)}`,
            { timeout: 8000 }
          );
          const results = r.data;
          if (Array.isArray(results) && results.length > 0) {
            schemeMap[isin] = String(results[0].schemeCode);
          }
        } catch {
          // lookup_failed stays true
        }
      })
    );
  }

  for (const fund of funds) {
    if (schemeMap[fund.isin]) {
      fund.scheme_code  = schemeMap[fund.isin];
      fund.lookup_failed = false;
    } else {
      fund.lookup_failed = true;
    }
  }

  return funds;
}

// ---------------------------------------------------------------------------
// POST /api/mutual-funds/cas/confirm
// ---------------------------------------------------------------------------

const confirmCasImport = async (req, res) => {
  const { funds } = req.body;
  if (!Array.isArray(funds) || funds.length === 0) {
    return fail(res, "No funds provided");
  }

  const client = await pool.connect();
  let inserted = 0;
  let skipped  = 0;

  try {
    await client.query("BEGIN");

    for (const fund of funds) {
      if (fund.lookup_failed || !fund.isin) continue;

      const nav = await getNavForScheme(fund.scheme_code);
      const latestNav      = nav?.latest_nav  ?? null;
      const latestNavDate  = nav?.nav_date     ?? null;

      for (const lot of (fund.lots ?? [])) {
        const units         = parseFloat(lot.units)   || 0;
        const purchaseNav   = parseFloat(lot.nav)     || 0;
        const amountInvested = parseFloat(lot.amount) || units * purchaseNav;
        const purchaseDate  = lot.date;

        if (units <= 0 || !purchaseDate) { skipped++; continue; }

        // Dedup check
        const dup = await client.query(
          `SELECT id FROM mutual_fund_holdings
           WHERE user_id = $1 AND isin = $2 AND folio_number = $3
             AND purchase_date = $4 AND ABS(units - $5) < 0.001`,
          [req.user_id, fund.isin, fund.folio_number ?? "UNKNOWN", purchaseDate, units]
        );
        if (dup.rows.length > 0) { skipped++; continue; }

        const currentValue     = latestNav != null ? parseFloat((units * latestNav).toFixed(2)) : 0;
        const absoluteReturn   = parseFloat((currentValue - amountInvested).toFixed(2));
        const absoluteReturnPct = amountInvested > 0
          ? parseFloat(((absoluteReturn / amountInvested) * 100).toFixed(2))
          : 0;

        await client.query(
          `INSERT INTO mutual_fund_holdings
             (user_id, isin, scheme_code, scheme_name, folio_number, amc_name,
              units, purchase_nav, purchase_date, amount_invested,
              latest_nav, latest_nav_date, current_value, absolute_return, absolute_return_pct,
              import_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'cas_pdf')`,
          [
            req.user_id, fund.isin, fund.scheme_code, fund.scheme_name,
            fund.folio_number ?? "UNKNOWN", fund.amc_name ?? null,
            units, purchaseNav, purchaseDate, amountInvested,
            latestNav, latestNavDate, currentValue, absoluteReturn, absoluteReturnPct,
          ]
        );
        inserted++;
      }
    }

    await client.query("COMMIT");
    return success(res, {
      message:  `Import complete`,
      inserted,
      skipped,
    }, 201);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[mf/cas-confirm] Error:", err.message);
    return fail(res, err.message, 500);
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// GET /api/mutual-funds/holdings
// ---------------------------------------------------------------------------

const getHoldings = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, isin, scheme_code, scheme_name, folio_number, amc_name,
              units, purchase_nav, purchase_date, amount_invested,
              latest_nav, latest_nav_date, current_value,
              absolute_return, absolute_return_pct, import_source, notes
       FROM mutual_fund_holdings
       WHERE user_id = $1
       ORDER BY scheme_name, purchase_date`,
      [req.user_id]
    );

    if (result.rows.length === 0) {
      return success(res, { funds: [], summary: { total_invested: 0, current_value: 0, absolute_return: 0, absolute_return_pct: 0 } });
    }

    // Collect unique scheme_codes for batch NAV refresh check
    const schemeCodes = [...new Set(result.rows.map((r) => r.scheme_code).filter(Boolean))];

    // Fetch fresh NAVs (uses 4h cache internally)
    const navMap = {};
    await Promise.all(
      schemeCodes.map(async (sc) => {
        const nav = await getNavForScheme(sc);
        if (nav) navMap[sc] = nav;
      })
    );

    // Group lots by ISIN
    const fundMap = {};
    for (const row of result.rows) {
      if (!fundMap[row.isin]) {
        fundMap[row.isin] = {
          isin:         row.isin,
          scheme_code:  row.scheme_code,
          scheme_name:  row.scheme_name,
          amc_name:     row.amc_name,
          lots:         [],
        };
      }
      fundMap[row.isin].lots.push({
        id:             row.id,
        purchase_date:  row.purchase_date?.toISOString?.()?.slice(0, 10) ?? String(row.purchase_date),
        units:          parseFloat(row.units),
        purchase_nav:   parseFloat(row.purchase_nav),
        amount_invested: parseFloat(row.amount_invested),
      });
    }

    // Build aggregated fund objects
    const funds = [];
    let totalInvested = 0;
    let totalCurrentValue = 0;

    for (const fund of Object.values(fundMap)) {
      const nav     = navMap[fund.scheme_code];
      const latestNav      = nav?.latest_nav  ?? null;
      const latestNavDate  = nav?.nav_date     ?? null;

      const totalUnits = fund.lots.reduce((s, l) => s + l.units, 0);
      const totalLotInvested = fund.lots.reduce((s, l) => s + l.amount_invested, 0);
      const avgNav = totalUnits > 0 ? totalLotInvested / totalUnits : 0;

      const currentValue = latestNav != null
        ? parseFloat((totalUnits * latestNav).toFixed(2))
        : fund.lots.reduce((s, l) => s + parseFloat(l.units) * parseFloat(l.purchase_nav), 0);

      const absReturn    = parseFloat((currentValue - totalLotInvested).toFixed(2));
      const absReturnPct = totalLotInvested > 0
        ? parseFloat(((absReturn / totalLotInvested) * 100).toFixed(2))
        : 0;

      const xirr = computeXirr(fund.lots, currentValue);

      totalInvested     += totalLotInvested;
      totalCurrentValue += currentValue;

      funds.push({
        isin:               fund.isin,
        scheme_code:        fund.scheme_code,
        scheme_name:        fund.scheme_name,
        amc_name:           fund.amc_name,
        total_units:        parseFloat(totalUnits.toFixed(3)),
        avg_nav:            parseFloat(avgNav.toFixed(4)),
        latest_nav:         latestNav,
        latest_nav_date:    latestNavDate,
        total_invested:     parseFloat(totalLotInvested.toFixed(2)),
        current_value:      currentValue,
        absolute_return:    absReturn,
        absolute_return_pct: absReturnPct,
        xirr,
        lots:               fund.lots,
      });
    }

    const totalAbsReturn    = parseFloat((totalCurrentValue - totalInvested).toFixed(2));
    const totalAbsReturnPct = totalInvested > 0
      ? parseFloat(((totalAbsReturn / totalInvested) * 100).toFixed(2))
      : 0;

    return success(res, {
      funds,
      summary: {
        total_invested:      parseFloat(totalInvested.toFixed(2)),
        current_value:       parseFloat(totalCurrentValue.toFixed(2)),
        absolute_return:     totalAbsReturn,
        absolute_return_pct: totalAbsReturnPct,
      },
    });
  } catch (err) {
    console.error("[mf/holdings GET] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ---------------------------------------------------------------------------
// GET /api/mutual-funds/summary
// ---------------------------------------------------------------------------

const getSummary = async (req, res) => {
  try {
    const [holdingsRes, cagrRes] = await Promise.all([
      pool.query(
        `SELECT isin, scheme_code, units, purchase_nav, amount_invested
         FROM mutual_fund_holdings WHERE user_id = $1`,
        [req.user_id]
      ),
      pool.query(
        `SELECT symbol, multiplier_1y::float8, multiplier_3y::float8, multiplier_5y::float8
         FROM asset_cagr WHERE asset_type = 'mf'`
      ),
    ]);

    if (holdingsRes.rows.length === 0) {
      return success(res, {
        total_invested: 0, current_value: 0,
        absolute_return: 0, absolute_return_pct: 0,
        projected_1y: 0, projected_3y: 0, projected_5y: 0, has_cagr: false,
      });
    }

    // Build CAGR map: isin → multipliers
    const cagrMap = {};
    for (const row of cagrRes.rows) {
      cagrMap[row.symbol] = {
        m1: row.multiplier_1y,
        m3: row.multiplier_3y,
        m5: row.multiplier_5y,
      };
    }

    // Group by ISIN to get fresh NAVs
    const schemeMap = {};
    for (const row of holdingsRes.rows) {
      if (!schemeMap[row.isin]) schemeMap[row.isin] = row.scheme_code;
    }

    const navMap = {};
    await Promise.all(
      Object.entries(schemeMap).map(async ([isin, sc]) => {
        const nav = await getNavForScheme(sc);
        if (nav) navMap[isin] = nav.latest_nav;
      })
    );

    let totalInvested = 0, currentValue = 0, p1 = 0, p3 = 0, p5 = 0;
    let hasCagr = false;

    // Group lots by ISIN
    const grouped = {};
    for (const row of holdingsRes.rows) {
      if (!grouped[row.isin]) grouped[row.isin] = [];
      grouped[row.isin].push(row);
    }

    for (const [isin, lots] of Object.entries(grouped)) {
      const latestNav = navMap[isin] ?? null;
      const totalUnits = lots.reduce((s, l) => s + parseFloat(l.units), 0);
      const lotInvested = lots.reduce((s, l) => s + parseFloat(l.amount_invested), 0);
      const cv = latestNav != null
        ? totalUnits * latestNav
        : lotInvested;

      totalInvested += lotInvested;
      currentValue  += cv;

      const cagr = cagrMap[isin];
      if (cagr) {
        hasCagr = true;
        p1 += cv * (cagr.m1 ?? 1);
        p3 += cv * (cagr.m3 ?? 1);
        p5 += cv * (cagr.m5 ?? 1);
      } else {
        p1 += cv;
        p3 += cv;
        p5 += cv;
      }
    }

    const absReturn    = parseFloat((currentValue - totalInvested).toFixed(2));
    const absReturnPct = totalInvested > 0
      ? parseFloat(((absReturn / totalInvested) * 100).toFixed(2))
      : 0;

    return success(res, {
      total_invested:      parseFloat(totalInvested.toFixed(2)),
      current_value:       parseFloat(currentValue.toFixed(2)),
      absolute_return:     absReturn,
      absolute_return_pct: absReturnPct,
      projected_1y:        parseFloat(p1.toFixed(2)),
      projected_3y:        parseFloat(p3.toFixed(2)),
      projected_5y:        parseFloat(p5.toFixed(2)),
      has_cagr:            hasCagr,
    });
  } catch (err) {
    console.error("[mf/summary GET] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ---------------------------------------------------------------------------
// POST /api/mutual-funds/holdings  (manual add single lot)
// ---------------------------------------------------------------------------

const addLot = async (req, res) => {
  const { isin, scheme_code, scheme_name, amc_name, folio_number, units, purchase_nav, purchase_date, notes } = req.body;

  if (!isin || !/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin.trim().toUpperCase())) {
    return fail(res, "Invalid ISIN format");
  }
  if (!units || parseFloat(units) <= 0) return fail(res, "units must be a positive number");
  if (!purchase_nav || parseFloat(purchase_nav) <= 0) return fail(res, "purchase_nav must be a positive number");
  if (!purchase_date) return fail(res, "purchase_date is required (YYYY-MM-DD)");

  const normalIsin = isin.trim().toUpperCase();
  let resolvedCode = scheme_code ?? null;
  let resolvedName = scheme_name ?? null;
  let resolvedAmc  = amc_name   ?? null;

  // Auto-resolve scheme_code if not provided
  if (!resolvedCode) {
    try {
      const r = await axios.get(`${MFAPI_BASE}/search?isin=${encodeURIComponent(normalIsin)}`, { timeout: 8000 });
      if (Array.isArray(r.data) && r.data.length > 0) {
        resolvedCode = String(r.data[0].schemeCode);
        resolvedName = resolvedName ?? r.data[0].schemeName;
      }
    } catch { /* proceed without scheme_code */ }
  }

  const nav = await getNavForScheme(resolvedCode);
  const latestNav     = nav?.latest_nav  ?? null;
  const latestNavDate = nav?.nav_date    ?? null;

  const u             = parseFloat(units);
  const pNav          = parseFloat(purchase_nav);
  const amountInvested = parseFloat((u * pNav).toFixed(2));
  const currentValue  = latestNav != null ? parseFloat((u * latestNav).toFixed(2)) : amountInvested;
  const absReturn     = parseFloat((currentValue - amountInvested).toFixed(2));
  const absReturnPct  = parseFloat(((absReturn / amountInvested) * 100).toFixed(2));

  try {
    const result = await pool.query(
      `INSERT INTO mutual_fund_holdings
         (user_id, isin, scheme_code, scheme_name, folio_number, amc_name,
          units, purchase_nav, purchase_date, amount_invested,
          latest_nav, latest_nav_date, current_value, absolute_return, absolute_return_pct,
          import_source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'manual',$16)
       RETURNING id`,
      [
        req.user_id, normalIsin, resolvedCode, resolvedName,
        folio_number ?? null, resolvedAmc,
        u, pNav, purchase_date, amountInvested,
        latestNav, latestNavDate, currentValue, absReturn, absReturnPct,
        notes ?? null,
      ]
    );
    const nav_warning = latestNav == null ? "Could not fetch current NAV — current_value equals cost" : undefined;
    return success(res, { id: result.rows[0].id, nav_warning }, 201);
  } catch (err) {
    console.error("[mf/holdings POST] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/mutual-funds/holdings/:id
// ---------------------------------------------------------------------------

const deleteLot = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM mutual_fund_holdings WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.user_id]
    );
    if (result.rows.length === 0) return fail(res, "Holding not found", 404);
    return success(res, { deleted_id: id });
  } catch (err) {
    console.error("[mf/holdings DELETE] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

// ---------------------------------------------------------------------------
// POST /api/mutual-funds/sync-cagr
// ---------------------------------------------------------------------------

const syncMfCagr = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT isin FROM mutual_fund_holdings WHERE user_id = $1 AND isin IS NOT NULL`,
      [req.user_id]
    );
    const isins = result.rows.map((r) => r.isin);

    if (isins.length === 0) {
      return success(res, { message: "No MF holdings found", updated: 0 });
    }

    await recomputeMfCagr(isins);

    return success(res, {
      message: "CAGR computed successfully",
      updated: isins.length,
      isins,
    });
  } catch (err) {
    console.error("[mf/sync-cagr] Error:", err.message);
    return fail(res, err.message, 500);
  }
};

module.exports = {
  lookupScheme,
  parseCasPdf,
  confirmCasImport,
  getHoldings,
  getSummary,
  addLot,
  deleteLot,
  syncMfCagr,
};
