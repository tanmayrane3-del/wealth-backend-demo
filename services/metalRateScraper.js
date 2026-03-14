const axios = require("axios");
const cheerio = require("cheerio");
const pool = require("../db");

const CACHE_TTL_MINUTES = 30;
const SCRAPE_URL = "https://www.goodreturns.in/gold-rates-in-india.html";

/**
 * Returns cached rates if fresh (< 30 min), otherwise scrapes GoodReturns
 * and inserts a new cache row.
 * @returns {{ gold_22k_per_gram: number, gold_24k_per_gram: number, fetched_at: string }}
 */
async function getLatestRates() {
  // Check cache first
  const cacheResult = await pool.query(
    `SELECT gold_22k_per_gram, gold_24k_per_gram, fetched_at
     FROM metal_rates_cache
     ORDER BY fetched_at DESC
     LIMIT 1`
  );

  if (cacheResult.rows.length > 0) {
    const cached = cacheResult.rows[0];
    const ageMinutes = (Date.now() - new Date(cached.fetched_at).getTime()) / 60000;
    if (ageMinutes < CACHE_TTL_MINUTES) {
      return {
        gold_22k_per_gram: parseFloat(cached.gold_22k_per_gram),
        gold_24k_per_gram: parseFloat(cached.gold_24k_per_gram),
        fetched_at: cached.fetched_at,
      };
    }
  }

  // Cache is stale or empty — scrape GoodReturns
  const rates = await scrapeGoodReturns();

  // Insert new cache row
  const insertResult = await pool.query(
    `INSERT INTO metal_rates_cache (gold_22k_per_gram, gold_24k_per_gram, source, fetched_at)
     VALUES ($1, $2, 'goodreturns', NOW())
     RETURNING fetched_at`,
    [rates.gold_22k_per_gram, rates.gold_24k_per_gram]
  );

  return {
    ...rates,
    fetched_at: insertResult.rows[0].fetched_at,
  };
}

/**
 * Scrapes Mumbai gold rates from GoodReturns.
 * Targets the "Gold Rates in Mumbai" section of the rates table.
 */
async function scrapeGoodReturns() {
  const response = await axios.get(SCRAPE_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-IN,en;q=0.9",
    },
    timeout: 15000,
  });

  const $ = cheerio.load(response.data);
  let gold22k = null;
  let gold24k = null;

  // GoodReturns gold page has a table with city-wise rates.
  // Each row: City | 22K (1g) | 24K (1g) | ...
  // Look for the row containing "Mumbai"
  $("table tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) return;

    const cityText = $(cells[0]).text().trim().toLowerCase();
    if (!cityText.includes("mumbai")) return;

    const raw22k = $(cells[1]).text().trim().replace(/[₹,\s]/g, "");
    const raw24k = $(cells[2]).text().trim().replace(/[₹,\s]/g, "");

    const parsed22k = parseFloat(raw22k);
    const parsed24k = parseFloat(raw24k);

    if (!isNaN(parsed22k) && parsed22k > 0) gold22k = parsed22k;
    if (!isNaN(parsed24k) && parsed24k > 0) gold24k = parsed24k;

    return false; // break out of each loop
  });

  // Fallback: try alternate table structure if above didn't work
  if (!gold22k || !gold24k) {
    $("tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 3) return;

      const cityText = $(cells[0]).text().trim().toLowerCase();
      if (!cityText.includes("mumbai")) return;

      const raw22k = $(cells[1]).text().trim().replace(/[₹,\s]/g, "");
      const raw24k = $(cells[2]).text().trim().replace(/[₹,\s]/g, "");

      const parsed22k = parseFloat(raw22k);
      const parsed24k = parseFloat(raw24k);

      if (!isNaN(parsed22k) && parsed22k > 0) gold22k = parsed22k;
      if (!isNaN(parsed24k) && parsed24k > 0) gold24k = parsed24k;

      return false;
    });
  }

  if (!gold22k || !gold24k) {
    throw new Error("Failed to extract gold rates from GoodReturns — page structure may have changed");
  }

  console.log(`[MetalRateScraper] Scraped rates — 22K: ₹${gold22k}/g, 24K: ₹${gold24k}/g`);

  return {
    gold_22k_per_gram: gold22k,
    gold_24k_per_gram: gold24k,
  };
}

module.exports = { getLatestRates };
