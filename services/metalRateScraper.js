const axios = require("axios");
const pool = require("../db");

const CACHE_TTL_MINUTES = 30;

// Free, no-auth APIs that work from server environments
const METALS_LIVE_URL   = "https://api.metals.live/v1/spot/gold"; // USD per troy oz
const EXCHANGE_RATE_URL = "https://open.er-api.com/v6/latest/USD"; // USD → INR

const TROY_OZ_TO_GRAMS = 31.1035;

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
     VALUES ($1, $2, 'metals.live+openexchange', NOW())
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
 *   1. metals.live  — gold spot price in USD / troy oz
 *   2. open.er-api  — USD → INR exchange rate
 *
 * Conversion:
 *   24K/gram (INR) = (gold_usd_per_troyoz × usd_inr) / 31.1035
 *   22K/gram (INR) = 24K/gram × (22/24)
 *
 * Note: Indian market 22K/24K retail rates carry a small making-charge
 * premium over spot, but spot-derived rates are accurate for valuation.
 */
async function fetchLiveRates() {
  const [goldRes, fxRes] = await Promise.all([
    axios.get(METALS_LIVE_URL,   { timeout: 10000 }),
    axios.get(EXCHANGE_RATE_URL, { timeout: 10000 }),
  ]);

  // metals.live returns: { "price": 3158.12 }
  const goldUsdPerTroyOz = goldRes.data?.price;
  if (!goldUsdPerTroyOz || isNaN(goldUsdPerTroyOz)) {
    throw new Error(`Unexpected response from metals.live: ${JSON.stringify(goldRes.data)}`);
  }

  // open.er-api returns: { "rates": { "INR": 85.42, ... } }
  const usdToInr = fxRes.data?.rates?.INR;
  if (!usdToInr || isNaN(usdToInr)) {
    throw new Error(`Unexpected response from open.er-api: ${JSON.stringify(fxRes.data)}`);
  }

  const gold24k = parseFloat(((goldUsdPerTroyOz * usdToInr) / TROY_OZ_TO_GRAMS).toFixed(2));
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
