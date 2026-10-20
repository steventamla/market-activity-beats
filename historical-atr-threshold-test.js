
"use strict";

/*
 * Historical ATR Threshold Test
 * Node.js 18+
 *
 * Tests ATR(14) separately on 5m, 15m, 1h and 4h candles.
 * Compares range/ATR thresholds with and without a 60% body filter.
 * Does not modify the live scanner.
 *
 * Required environment variable:
 * TWELVE_DATA_API_KEY
 *
 * Optional:
 * TEST_DAYS=5
 * MAX_PAIRS=28
 *
 * IMPORTANT:
 * Requests are spaced to reduce rate-limit errors.
 * Testing 28 pairs may take around 30 minutes or longer.
 */

const API_KEY = process.env.TWELVE_DATA_API_KEY;

const DAYS = Math.max(
  2,
  Math.min(14, Number.parseInt(process.env.TEST_DAYS || "5", 10) || 5)
);

const MAX_PAIRS = Math.max(
  1,
  Math.min(28, Number.parseInt(process.env.MAX_PAIRS || "28", 10) || 28)
);

const THRESHOLDS = [1.5, 2.0, 2.5, 3.0];
const ATR_PERIOD = 14;
const BODY_RATIO_MIN = 0.60;
const FIVE_MIN_MS = 5 * 60 * 1000;
const REQUEST_DELAY_MS = 65000;
const MAX_RETRIES = 3;

const PAIRS = [
  "EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD",
  "USD/CAD", "USD/CHF", "USD/JPY",
  "EUR/GBP", "EUR/JPY", "EUR/CHF",
  "EUR/AUD", "EUR/CAD", "EUR/NZD",
  "GBP/JPY", "GBP/CHF", "GBP/AUD",
  "GBP/CAD", "GBP/NZD",
  "AUD/NZD", "AUD/CAD", "AUD/CHF", "AUD/JPY",
  "NZD/CAD", "NZD/CHF", "NZD/JPY",
  "CAD/CHF", "CAD/JPY", "CHF/JPY"
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
  if (!candle?.datetime) return NaN;

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

function trueRange(candles, index) {
  const current = candles[index];
  const high = number(current.high);
  const low = number(current.low);

  if (high === null || low === null || high < low) return null;

  // The first candle has no previous close for gap calculations.
  if (index === 0) return high - low;

  const previousClose = number(candles[index - 1].close);
  if (previousClose === null) return null;

  return Math.max(
    high - low,
    Math.abs(high - previousClose),
    Math.abs(low - previousClose)
  );
}

/*
 * Wilder ATR(14).
 * Signals compare the current candle's range with ATR known BEFORE
 * that candle, preventing the current candle from inflating its own
 * threshold.
 */
function calculateATR(candles, period = ATR_PERIOD) {
  const tr = candles.map((_, index) => trueRange(candles, index));
  const atr = new Array(candles.length).fill(null);

  if (candles.length <= period) return atr;

  const seedValues = tr.slice(1, period + 1);

  if (seedValues.some(value => value === null)) return atr;

  let previousATR =
    seedValues.reduce((sum, value) => sum + value, 0) / period;

  atr[period] = previousATR;

  for (let i = period + 1; i < candles.length; i++) {
    if (tr[i] === null) {
      previousATR = null;
      continue;
    }

    if (previousATR === null) {
      const start = i - period + 1;
      const window = tr.slice(start, i + 1);

      if (window.length !== period || window.some(v => v === null)) {
        continue;
      }

      previousATR =
        window.reduce((sum, value) => sum + value, 0) / period;
    } else {
      previousATR =
        ((previousATR * (period - 1)) + tr[i]) / period;
    }

    atr[i] = previousATR;
  }

  return atr;
}

async function fetchCandles(symbol) {
  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "5min");
  url.searchParams.set(
    "outputsize",
    String(Math.min(5000, DAYS * 288 + 100))
  );
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`  Waiting before retry ${attempt} for ${symbol}...`);
      await sleep(REQUEST_DELAY_MS);
    }

    let response;
    let data;

    try {
      response = await fetch(url);
      data = await response.json();
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Network failure: ${error.message}`);
      }
      continue;
    }

    const invalid =
      !response.ok ||
      data?.status === "error" ||
      data?.code ||
      !Array.isArray(data?.values);

    if (invalid) {
      const message =
        data?.message ||
        (data?.code ? `API error ${data.code}` : `HTTP ${response.status}`);

      if (attempt === MAX_RETRIES) {
        throw new Error(`${symbol}: ${message}`);
      }

      console.log(`  ${symbol}: ${message}; retrying.`);
      continue;
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

    if (candles.length < ATR_PERIOD + 2) {
      throw new Error(
        `${symbol}: insufficient completed candles (${candles.length})`
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
    const expected = Array.from(
      { length: timeframe.n },
      (_, index) => start + index * FIVE_MIN_MS
    );

    // Exclude incomplete higher-timeframe candles.
    if (!expected.every(time => bucket.has(time))) continue;

    const group = expected.map(time => bucket.get(time));
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

function evaluateThreshold(candles, threshold) {
  const atr = calculateATR(candles);
  let eligible = 0;
  let rangeSignals = 0;
  let bodySignals = 0;

  for (let i = ATR_PERIOD + 1; i < candles.length; i++) {
    const current = candles[i];

    // Use ATR from the previous candle, not the current candle.
    const priorATR = atr[i - 1];
    const range = candleRange(current);

    if (
      priorATR === null ||
      priorATR === undefined ||
      !Number.isFinite(priorATR) ||
      priorATR <= 0 ||
      range === null
    ) {
      continue;
    }

    eligible++;

    if (range < threshold * priorATR) continue;

    rangeSignals++;

    const open = number(current.open);
    const close = number(current.close);
    const body = Math.abs(close - open);

    if (range > 0 && body / range >= BODY_RATIO_MIN) {
      bodySignals++;
    }
  }

  const filteredOut = rangeSignals - bodySignals;
  const filteredPercent = rangeSignals > 0
    ? (filteredOut / rangeSignals) * 100
    : 0;

  return {
    eligible,
    rangeSignals,
    bodySignals,
    filteredOut,
    filteredPercent
  };
}

function printTable(rows) {
  console.log("");
  console.log(
    "TF  | ATR threshold | Eligible | Range signals | After 60% body filter | Removed %"
  );
  console.log("-".repeat(86));

  for (const row of rows) {
    console.log(
      `${row.timeframe.padEnd(3)} | ` +
      `${String(row.threshold).padEnd(13)} | ` +
      `${String(row.eligible).padStart(8)} | ` +
      `${String(row.rangeSignals).padStart(13)} | ` +
      `${String(row.bodySignals).padStart(21)} | ` +
      `${row.filteredPercent.toFixed(1)}%`
    );
  }
}

async function main() {
  if (!API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing. Set it as an environment variable. Do not paste your API key into this file."
    );
  }

  const pairs = PAIRS.slice(0, MAX_PAIRS);
  const datasets = new Map();
  const failures = [];

  console.log("HISTORICAL ATR THRESHOLD TEST");
  console.log(`Pairs: ${pairs.length}`);
  console.log(`History requested: ${DAYS} days`);
  console.log(`ATR period: ${ATR_PERIOD}`);
  console.log(`Thresholds: ${THRESHOLDS.join(", ")} × ATR`);
  console.log(`Body filter: body/range >= ${BODY_RATIO_MIN}`);
  console.log("Each request is spaced by 65 seconds to reduce rate-limit errors.");
  console.log("");

  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];

    if (index > 0) {
      await sleep(REQUEST_DELAY_MS);
    }

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

  if (failures.length > 0 || datasets.size !== pairs.length) {
    console.error("");
    console.error("TEST INCOMPLETE — DO NOT SELECT A FINAL THRESHOLD");
    console.error(`Successful pairs: ${datasets.size}/${pairs.length}`);

    for (const failure of failures) {
      console.error(`- ${failure}`);
    }

    throw new Error(
      "Some pairs failed. Resolve API, credit or data issues before using the comparison."
    );
  }

  const rows = [];

  for (const timeframe of TIMEFRAMES) {
    for (const threshold of THRESHOLDS) {
      const total = {
        timeframe: timeframe.label,
        threshold,
        eligible: 0,
        rangeSignals: 0,
        bodySignals: 0,
        filteredOut: 0,
        filteredPercent: 0
      };

      for (const fiveMinuteCandles of datasets.values()) {
        const candles = aggregateCandles(fiveMinuteCandles, timeframe);
        const result = evaluateThreshold(candles, threshold);

        total.eligible += result.eligible;
        total.rangeSignals += result.rangeSignals;
        total.bodySignals += result.bodySignals;
        total.filteredOut += result.filteredOut;
      }

      total.filteredPercent = total.rangeSignals > 0
        ? (total.filteredOut / total.rangeSignals) * 100
        : 0;

      rows.push(total);
    }
  }

  console.log("");
  console.log("RESULTS — ALL REQUESTED PAIRS SUCCESSFULLY TESTED");
  printTable(rows);

  console.log("");
  console.log(`Pairs tested: ${datasets.size}/${pairs.length}`);
  console.log("ATR is calculated independently on each timeframe's candles.");
  console.log("The current candle's range is compared with ATR known before that candle.");
  console.log("The body filter is evaluated separately from the ATR threshold.");
  console.log("Signal counts show frequency, not whether activity was institution-driven.");
  console.log("This script does not modify the live scanner.");

  console.log("");
  console.log(
    "NEXT STEP: compare these counts with observed market activity before choosing the final threshold."
  );
}

main().catch(error => {
  console.error("");
  console.error(`TEST FAILED: ${error.message}`);
  process.exitCode = 1;
});
