
/**
 * Historical Threshold Test
 * Node.js 18+
 *
 * Tests thresholds using historical Twelve Data candles.
 * Does not modify the live scanner.
 *
 * Required environment variable:
 * TWELVE_DATA_API_KEY
 */

"use strict";

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const DAYS = Math.max(
  2,
  Math.min(14, Number.parseInt(process.env.TEST_DAYS || "5", 10) || 5)
);
const MAX_PAIRS = Math.max(
  1,
  Math.min(4, Number.parseInt(process.env.MAX_PAIRS || "4", 10) || 4)
);

const THRESHOLDS = [1.5, 1.75, 2, 2.25, 2.5, 3];
const BASELINE = 14;
const FIVE_MIN_MS = 5 * 60 * 1000;
const REQUEST_DELAY_MS = 65000;
const RETRY_DELAY_MS = 65000;
const MAX_RETRIES = 3;
const BODY_RATIO_MIN = 0.60;

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "AUD/USD",
  "NZD/USD"
];

const TIMEFRAMES = [
  { label: "5m", ms: 5 * 60 * 1000, n: 1 },
  { label: "15m", ms: 15 * 60 * 1000, n: 3 },
  { label: "1h", ms: 60 * 60 * 1000, n: 12 },
  { label: "4h", ms: 4 * 60 * 60 * 1000, n: 48 }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function candleTime(candle) {
  if (!candle || !candle.datetime) return NaN;

  const value = String(candle.datetime).replace(" ", "T");
  const normalized = /Z$|[+-]\d\d:\d\d$/.test(value)
    ? value
    : `${value}Z`;

  return Date.parse(normalized);
}

function candleRange(candle) {
  const high = number(candle.high);
  const low = number(candle.low);

  if (high === null || low === null || high < low) return null;

  return high - low;
}

function errorMessage(data, status) {
  if (data && data.message) return String(data.message);
  if (data && data.code) return `API error ${data.code}`;
  return `HTTP ${status}`;
}

function isRateLimit(message) {
  return /rate.?limit|credits per minute|credits were used|too many requests|429|current minute/i.test(
    message
  );
}

async function fetchCandles(symbol) {
  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "5min");
  url.searchParams.set("outputsize", String(Math.min(5000, DAYS * 288 + 60)));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Space requests apart to reduce rate-limit errors.
    if (attempt > 0) {
      await sleep(RETRY_DELAY_MS);
    } else {
      await sleep(REQUEST_DELAY_MS);
    }

    let response;
    let data;

    try {
      response = await fetch(url);
      data = await response.json();
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Network failure for ${symbol}: ${error.message}`);
      }

      console.log(`  Network error for ${symbol}; retry ${attempt + 1}.`);
      continue;
    }

    const invalid =
      !response.ok ||
      (data && data.status === "error") ||
      (data && data.code) ||
      !data ||
      !Array.isArray(data.values);

    if (invalid) {
      const message = errorMessage(data, response.status);

      if (attempt < MAX_RETRIES) {
        console.log(`  ${symbol}: ${message}; will retry.`);
        continue;
      }

      throw new Error(`${symbol}: ${message}`);
    }

    const now = Date.now();

    const candles = data.values
      .filter(candle => {
        const time = candleTime(candle);

        return (
          Number.isFinite(time) &&
          time + FIVE_MIN_MS <= now &&
          candleRange(candle) !== null &&
          number(candle.open) !== null &&
          number(candle.close) !== null
        );
      })
      .sort((a, b) => candleTime(a) - candleTime(b));

    if (candles.length <= BASELINE) {
      throw new Error(
        `${symbol}: insufficient completed historical candles (${candles.length})`
      );
    }

    return candles;
  }

  throw new Error(`${symbol}: failed after retries`);
}

function aggregateCandles(candles, timeframe) {
  if (timeframe.n === 1) return candles;

  const buckets = new Map();

  for (const candle of candles) {
    const time = candleTime(candle);
    const start = Math.floor(time / timeframe.ms) * timeframe.ms;

    if (!buckets.has(start)) buckets.set(start, new Map());
    buckets.get(start).set(time, candle);
  }

  const result = [];

  for (const [start, bucket] of buckets) {
    const expectedTimes = Array.from(
      { length: timeframe.n },
      (_, index) => start + index * FIVE_MIN_MS
    );

    // Do not treat incomplete groups as completed candles.
    if (!expectedTimes.every(time => bucket.has(time))) continue;

    const group = expectedTimes.map(time => bucket.get(time));
    const highs = group.map(candle => number(candle.high));
    const lows = group.map(candle => number(candle.low));
    const open = number(group[0].open);
    const close = number(group[group.length - 1].close);

    if (
      open === null ||
      close === null ||
      highs.some(value => value === null) ||
      lows.some(value => value === null)
    ) {
      continue;
    }

    result.push({
      datetime: new Date(start).toISOString(),
      open,
      high: Math.max(...highs),
      low: Math.min(...lows),
      close
    });
  }

  return result.sort((a, b) => candleTime(a) - candleTime(b));
}

function testThreshold(candles, threshold) {
  let eligible = 0;
  let rangeSignals = 0;
  let bodySignals = 0;

  for (let index = BASELINE; index < candles.length; index++) {
    const current = candles[index];
    const currentRange = candleRange(current);

    const previousRanges = candles
      .slice(index - BASELINE, index)
      .map(candleRange);

    if (
      currentRange === null ||
      previousRanges.some(value => value === null)
    ) {
      continue;
    }

    const average =
      previousRanges.reduce((sum, value) => sum + value, 0) /
      previousRanges.length;

    if (average <= 0) continue;

    eligible++;

    if (currentRange < threshold * average) continue;

    rangeSignals++;

    const body = Math.abs(
      number(current.close) - number(current.open)
    );

    if (
      currentRange > 0 &&
      body / currentRange >= BODY_RATIO_MIN
    ) {
      bodySignals++;
    }
  }

  return { eligible, rangeSignals, bodySignals };
}

function printTable(rows) {
  console.log("");
  console.log(
    "Threshold | TF  | Eligible candles | Range signals | Body-filter signals | Filtered out %"
  );
  console.log("-".repeat(91));

  for (const row of rows) {
    const filtered = row.rangeSignals > 0
      ? ((row.rangeSignals - row.bodySignals) / row.rangeSignals) * 100
      : 0;

    console.log(
      `${String(row.threshold).padEnd(9)} | ` +
      `${row.timeframe.padEnd(3)} | ` +
      `${String(row.eligible).padStart(16)} | ` +
      `${String(row.rangeSignals).padStart(13)} | ` +
      `${String(row.bodySignals).padStart(19)} | ` +
      `${filtered.toFixed(1)}%`
    );
  }
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing. Set it in GitHub Actions Secrets; never paste the key into this file."
    );
  }

  const pairs = PAIRS.slice(0, MAX_PAIRS);
  const datasets = new Map();
  const failures = [];

  console.log("HISTORICAL THRESHOLD TEST");
  console.log(`Pairs required: ${pairs.join(", ")}`);
  console.log(`History requested: ${DAYS} days`);
  console.log(`Thresholds: ${THRESHOLDS.join(", ")}`);
  console.log(`Body filter: ${BODY_RATIO_MIN * 100}%`);
  console.log("");

  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];

    console.log(`[${index + 1}/${pairs.length}] Fetching ${pair}...`);

    try {
      const candles = await fetchCandles(pair);
      datasets.set(pair, candles);
      console.log(`  Success: ${candles.length} completed 5m candles.`);
    } catch (error) {
      failures.push(`${pair}: ${error.message}`);
      console.error(`  FAILED: ${error.message}`);
    }
  }

  // Do not choose a threshold from incomplete pair coverage.
  if (failures.length > 0 || datasets.size !== pairs.length) {
    console.error("");
    console.error("TEST INCOMPLETE — NO THRESHOLD RECOMMENDATION");
    console.error(`Successful pairs: ${datasets.size}/${pairs.length}`);

    for (const failure of failures) {
      console.error(`- ${failure}`);
    }

    throw new Error(
      "Not all required pairs were retrieved. Check the Twelve Data plan, credits, API key and rate limits, then rerun."
    );
  }

  const rows = [];

  for (const timeframe of TIMEFRAMES) {
    for (const threshold of THRESHOLDS) {
      const total = {
        threshold,
        timeframe: timeframe.label,
        eligible: 0,
        rangeSignals: 0,
        bodySignals: 0
      };

      for (const candles of datasets.values()) {
        const aggregated = aggregateCandles(candles, timeframe);
        const result = testThreshold(aggregated, threshold);

        total.eligible += result.eligible;
        total.rangeSignals += result.rangeSignals;
        total.bodySignals += result.bodySignals;
      }

      rows.push(total);
    }
  }

  console.log("");
  console.log("RESULTS — ALL REQUIRED PAIRS TESTED");
  printTable(rows);

  console.log("");
  console.log(`Pairs successfully tested: ${datasets.size}/${pairs.length}`);
  console.log("Range signals are candle expansions compared with the previous 14 candles.");
  console.log("Body-filter signals require the candle body to be at least 60% of its full range.");
  console.log("These counts measure historical candle behaviour; they do not prove institutional activity or future accuracy.");
  console.log("The live scanner has not been changed.");
}

main().catch(error => {
  console.error("");
  console.error(`TEST FAILED: ${error.message}`);
  process.exitCode = 1;
});
