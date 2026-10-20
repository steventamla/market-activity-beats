
/**
 * Historical Threshold Test
 * Node.js 18+
 *
 * Run:
 *   node historical-threshold-test.js
 *
 * Optional:
 *   TEST_DAYS=5 MAX_PAIRS=4 node historical-threshold-test.js
 *
 * Required environment variable:
 *   TWELVE_DATA_API_KEY
 *
 * This test does not modify or run the live scanner.
 */

const API_KEY = process.env.TWELVE_DATA_API_KEY;

const DAYS = Math.max(
  2,
  Number.parseInt(process.env.TEST_DAYS || "5", 10)
);

const MAX_PAIRS = Math.max(
  1,
  Math.min(28, Number.parseInt(process.env.MAX_PAIRS || "4", 10))
);

// Twelve Data Basic allows 8 credits per minute.
// Ten-second spacing stays below that request frequency.
const REQUEST_DELAY_MS = 10_000;
const RETRY_DELAY_MS = 65_000;
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

const THRESHOLDS = [1.5, 1.75, 2, 2.25, 2.5, 3];
const BASELINE = 14;
const FIVE_MIN_MS = 5 * 60 * 1000;

const TIMEFRAMES = [
  { label: "5m", ms: 5 * 60 * 1000, n: 1 },
  { label: "15m", ms: 15 * 60 * 1000, n: 3 },
  { label: "1h", ms: 60 * 60 * 1000, n: 12 },
  { label: "4h", ms: 4 * 60 * 60 * 1000, n: 48 }
];

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function candleTime(candle) {
  if (!candle?.datetime) return NaN;

  const value = String(candle.datetime);
  const iso = value.includes("T")
    ? value
    : value.replace(" ", "T");

  return Date.parse(
    /[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z"
  );
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function candleRange(candle) {
  const high = numberOrNull(candle.high);
  const low = numberOrNull(candle.low);

  if (high === null || low === null || high < low) {
    return null;
  }

  return high - low;
}

function apiErrorMessage(data, status) {
  if (data?.message) return data.message;
  if (data?.code) return `API error code ${data.code}`;
  return `HTTP status ${status}`;
}

function isRateLimitError(message) {
  return /rate limit|credits per minute|run out of api credits|too many requests|429/i
    .test(message);
}

async function fetchCandles(symbol) {
  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "5min");
  url.searchParams.set(
    "outputsize",
    String(Math.min(5000, DAYS * 288 + 60))
  );
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Space every API attempt, including retries.
    await sleep(REQUEST_DELAY_MS);

    let response;
    let data;

    try {
      response = await fetch(url);
      data = await response.json();
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Network failure: ${error.message}`);
      }

      const wait = Math.min(
        RETRY_DELAY_MS,
        15_000 * (attempt + 1)
      );

      console.log(`  Network issue. Retrying in ${wait / 1000}s.`);
      await sleep(wait);
      continue;
    }

    const invalid =
      !response.ok ||
      data?.status === "error" ||
      Boolean(data?.code) ||
      !Array.isArray(data?.values);

    if (invalid) {
      const message = apiErrorMessage(data, response.status);

      if (isRateLimitError(message) && attempt < MAX_RETRIES) {
        console.log(
          `  Rate limit reached for ${symbol}. ` +
          `Waiting ${RETRY_DELAY_MS / 1000}s before retry.`
        );

        await sleep(RETRY_DELAY_MS);
        continue;
      }

      throw new Error(message);
    }

    const now = Date.now();

    return data.values
      .filter(candle => {
        const time = candleTime(candle);

        return (
          Number.isFinite(time) &&
          time + FIVE_MIN_MS <= now &&
          candleRange(candle) !== null &&
          numberOrNull(candle.open) !== null &&
          numberOrNull(candle.close) !== null
        );
      })
      .sort((a, b) => candleTime(a) - candleTime(b));
  }

  throw new Error("Request failed after all retries.");
}

/**
 * Build higher-timeframe candles from complete 5-minute candles.
 * Incomplete buckets are excluded.
 */
function aggregateCandles(candles, timeframe) {
  if (timeframe.n === 1) return candles;

  const buckets = new Map();

  for (const candle of candles) {
    const time = candleTime(candle);
    const start = Math.floor(time / timeframe.ms) * timeframe.ms;

    if (!buckets.has(start)) {
      buckets.set(start, new Map());
    }

    buckets.get(start).set(time, candle);
  }

  const result = [];

  for (const [start, bucket] of buckets) {
    const expectedTimes = Array.from(
      { length: timeframe.n },
      (_, index) => start + index * FIVE_MIN_MS
    );

    if (!expectedTimes.every(time => bucket.has(time))) {
      continue;
    }

    const group = expectedTimes.map(time => bucket.get(time));
    const highs = group.map(candle => numberOrNull(candle.high));
    const lows = group.map(candle => numberOrNull(candle.low));

    const open = numberOrNull(group[0].open);
    const close = numberOrNull(group[group.length - 1].close);

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

  return result;
}

/**
 * Compare each candle's full high-low range against
 * the average range of the 14 candles immediately before it.
 */
function testThreshold(candles, threshold) {
  let eligible = 0;
  let rangeSignals = 0;
  let bodySignals = 0;

  const ratios = [];

  for (let index = BASELINE; index < candles.length; index++) {
    const current = candles[index];
    const currentRange = candleRange(current);

    const previousRanges = candles
      .slice(index - BASELINE, index)
      .map(candleRange);

    if (
      currentRange === null ||
      previousRanges.some(range => range === null)
    ) {
      continue;
    }

    const average =
      previousRanges.reduce((sum, range) => sum + range, 0) /
      previousRanges.length;

    if (average <= 0) continue;

    eligible++;

    const ratio = currentRange / average;

    if (ratio < threshold) continue;

    rangeSignals++;
    ratios.push(ratio);

    const open = numberOrNull(current.open);
    const close = numberOrNull(current.close);
    const body = Math.abs(close - open);

    // Diagnostic count only; this filter is not applied
    // to the range-signal count.
    if (currentRange > 0 && body / currentRange >= 0.60) {
      bodySignals++;
    }
  }

  ratios.sort((a, b) => a - b);

  return {
    eligible,
    rangeSignals,
    bodySignals,
    median: ratios.length
      ? ratios[Math.floor(ratios.length / 2)]
      : null
  };
}

function formatRow(values) {
  return values
    .map(value => String(value).padEnd(19))
    .join("| ");
}

async function main() {
  if (!API_KEY) {
    console.error(
      "Missing TWELVE_DATA_API_KEY environment variable."
    );
    console.error(
      "Set it in your environment or GitHub Actions secret. " +
      "Do not paste the key into this file."
    );
    process.exitCode = 1;
    return;
  }

  const pairs = PAIRS.slice(0, MAX_PAIRS);
  const data = new Map();

  console.log("HISTORICAL THRESHOLD TEST");
  console.log("Pairs:", pairs.join(", "));
  console.log("History requested:", DAYS, "days");
  console.log("Thresholds:", THRESHOLDS.join(", "));
  console.log("Request spacing:", REQUEST_DELAY_MS / 1000, "seconds");
  console.log("Maximum retries per pair:", MAX_RETRIES);
  console.log("");

  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index];

    console.log(
      `[${index + 1}/${pairs.length}] Fetching ${pair}...`
    );

    try {
      const candles = await fetchCandles(pair);
      data.set(pair, candles);

      console.log(
        `  Received ${candles.length} completed 5m candles.`
      );
    } catch (error) {
      console.error(`  FAILED ${pair}: ${error.message}`);
    }
  }

  if (data.size === 0) {
    console.error(
      "\nNo historical data was retrieved. Check the API key, " +
      "remaining credits, and Twelve Data plan limits."
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nRESULTS");
  console.log(
    "Threshold | TF | Eligible candles | Range signals | " +
    "Body-filter signals | Median ratio"
  );
  console.log("-".repeat(88));

  for (const timeframe of TIMEFRAMES) {
    for (const threshold of THRESHOLDS) {
      let eligible = 0;
      let signals = 0;
      let bodySignals = 0;
      const medians = [];

      for (const candles of data.values()) {
        const aggregated = aggregateCandles(candles, timeframe);
        const result = testThreshold(aggregated, threshold);

        eligible += result.eligible;
        signals += result.rangeSignals;
        bodySignals += result.bodySignals;

        if (result.median !== null) {
          medians.push(result.median);
        }
      }

      medians.sort((a, b) => a - b);

      const median = medians.length
        ? medians[Math.floor(medians.length / 2)].toFixed(2)
        : "-";

      console.log(
        `${String(threshold).padEnd(9)} | ` +
        `${timeframe.label.padEnd(2)} | ` +
        `${String(eligible).padEnd(16)} | ` +
        `${String(signals).padEnd(13)} | ` +
        `${String(bodySignals).padEnd(19)} | ${median}`
      );
    }
  }

  console.log("\nTest complete.");
  console.log("Pairs successfully tested:", data.size, "of", pairs.length);
  console.log(
    "These counts measure historical candle expansions, " +
    "not proven institutional activity or predictive accuracy."
  );
  console.log(
    "The body-filter count is diagnostic only; it is not " +
    "applied to the range-signal count or the live scanner."
  );

  if (data.size < pairs.length) {
    console.log(
      "WARNING: Some pairs failed. Results cover only the pairs " +
      "whose historical data was retrieved successfully."
    );
  }
}

main().catch(error => {
  console.error("Test failed:", error.message);
  process.exitCode = 1;
});
