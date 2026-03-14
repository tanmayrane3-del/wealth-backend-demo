const axios = require("axios");
const pool = require("../db");

const CACHE_TTL_MINUTES = 720; // 12 hours

// Free, no-auth APIs that work from server environments
const YAHOO_GOLD_URL    = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=1d"; // gold futures USD/oz
const EXCHANGE_RATE_URL = "https://open.er-api.com/v6/latest/USD"; // USD → INR

const TROY_OZ_TO_GRAMS = 31.1035;
const INDIA_IMPORT_DUTY = 1.06; // 6% import duty on gold

/**
 * Returns cached rates if fresh (< 30 min), otherwise fetches from API.
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

  // Cache is stale or empty — fetch from API
  const rates = await fetchLiveRates();

  const insertResult = await pool.query(
    `INSERT INTO metal_rates_cache (gold_22k_per_gram, gold_24k_per_gram, source, fetched_at)
     VALUES ($1, $2, 'yahoo-finance+openexchange', NOW())
     RETURNING fetched_at`,
    [rates.gold_22k_per_gram, rates.gold_24k_per_gram]
  );

  return {
    ...rates,
    fetched_at: insertResult.rows[0].fetched_at,
  };
}

/**
 * Fetches live gold rates via:
 *   1. Yahoo Finance (GC=F) — gold futures price in USD / troy oz
 *   2. open.er-api          — USD → INR exchange rate
 *
 * Conversion:
 *   24K/gram (INR) = (gold_usd_per_troyoz × usd_inr) / 31.1035
 *   22K/gram (INR) = 24K/gram × (22/24)
 */
async function fetchLiveRates() {
  const [goldRes, fxRes] = await Promise.all([
    axios.get(YAHOO_GOLD_URL,    { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } }),
    axios.get(EXCHANGE_RATE_URL, { timeout: 10000 }),
  ]);

  // Yahoo Finance returns: chart.result[0].meta.regularMarketPrice (USD/oz)
  const goldUsdPerTroyOz = goldRes.data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!goldUsdPerTroyOz || isNaN(goldUsdPerTroyOz)) {
    throw new Error(`Unexpected response from Yahoo Finance: ${JSON.stringify(goldRes.data?.chart?.result?.[0]?.meta)}`);
  }

  // open.er-api returns: { "rates": { "INR": 85.42, ... } }
  const usdToInr = fxRes.data?.rates?.INR;
  if (!usdToInr || isNaN(usdToInr)) {
    throw new Error(`Unexpected response from open.er-api: ${JSON.stringify(fxRes.data)}`);
  }

  const gold24k = parseFloat(((goldUsdPerTroyOz * usdToInr) / TROY_OZ_TO_GRAMS * INDIA_IMPORT_DUTY).toFixed(2));
  const gold22k = parseFloat((gold24k * (22 / 24)).toFixed(2));

  console.log(
    `[MetalRates] Fetched — spot: $${goldUsdPerTroyOz}/oz, ` +
    `USD/INR: ${usdToInr}, 24K: ₹${gold24k}/g, 22K: ₹${gold22k}/g`
  );

  return {
    gold_22k_per_gram: gold22k,
    gold_24k_per_gram: gold24k,
  };
}

module.exports = { getLatestRates };
