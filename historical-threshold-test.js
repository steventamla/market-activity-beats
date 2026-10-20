/**
 * Historical Threshold Test
 * Node.js 18+
 *
 * Tests six thresholds on historical Twelve Data candles.
 * Does not modify or run the live scanner.
 *
 * Run in GitHub Actions using the existing workflow.
 */

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const DAYS = Math.max(2, Number.parseInt(process.env.TEST_DAYS || "5", 10));
const MAX_PAIRS = Math.max(1, Math.min(28, Number.parseInt(process.env.MAX_PAIRS || "4", 10)));

const THRESHOLDS = [1.5, 1.75, 2, 2.25, 2.5, 3];
const BASELINE = 14;
const FIVE_MIN_MS = 300000;
const REQUEST_DELAY_MS = 10000;
const RETRY_DELAY_MS = 65000;
const MAX_RETRIES = 3;
const BODY_RATIO_MIN = 0.60;

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

function candleTime(candle) {
  if (!candle?.datetime) return NaN;

  const value = String(candle.datetime);
  const iso = value.includes("T") ? value : value.replace(" ", "T");

  return Date.parse(
    /[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z"
  );
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function range(candle) {
  const high = num(candle.high);
  const low = num(candle.low);

  if (high === null || low === null || high < low) return null;
  return high - low;
}

function apiError(data, status) {
  if (data?.message) return data.message;
  if (data?.code) return `API error code ${data.code}`;
  return `HTTP ${status}`;
}

function rateLimited(message) {
  return /rate limit|credits per minute|too many requests|429/i.test(message);
}

async function fetchCandles(symbol) {
  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "5min");
  url.searchParams.set("outputsize", String(Math.min(5000, DAYS * 288 + 60)));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await sleep(REQUEST_DELAY_MS);

    let response;
    let data;

    try {
      response = await fetch(url);
      data = await response.json();
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      const wait = Math.min(RETRY_DELAY_MS, 15000 * (attempt + 1));
      console.log(`  Network error; retrying in ${wait / 1000}s.`);
      await sleep(wait);
      continue;
    }

    const invalid =
      !response.ok ||
      data?.status === "error" ||
      Boolean(data?.code) ||
      !Array.isArray(data?.values);

    if (invalid) {
      const message = apiError(data, response.status);

      if (rateLimited(message) && attempt < MAX_RETRIES) {
        console.log(`  Rate limit; waiting ${RETRY_DELAY_MS / 1000}s.`);
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
          range(candle) !== null &&
          num(candle.open) !== null &&
          num(candle.close) !== null
        );
      })
      .sort((a, b) => candleTime(a) - candleTime(b));
  }

  throw new Error(`Could not retrieve ${symbol}`);
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
    const times = Array.from(
      { length: timeframe.n },
      (_, i) => start + i * FIVE_MIN_MS
    );

    if (!times.every(time => bucket.has(time))) continue;

    const group = times.map(time => bucket.get(time));
    const highs = group.map(c => num(c.high));
    const lows = group.map(c => num(c.low));
    const open = num(group[0].open);
    const close = num(group[group.length - 1].close);

    if (
      open === null ||
      close === null ||
      highs.some(v => v === null) ||
      lows.some(v => v === null)
    ) continue;

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

/**
 * A signal occurs when current range >= threshold * average
 * range of the previous 14 candles.
 *
 * Body-filter signal additionally requires:
 * absolute(close - open) / (high - low) >= 0.60
 */
function testThreshold(candles, threshold) {
  let eligible = 0;
  let rangeSignals = 0;
  let bodySignals = 0;
  const ratios = [];

  for (let i = BASELINE; i < candles.length; i++) {
    const current = candles[i];
    const currentRange = range(current);

    const previous = candles
      .slice(i - BASELINE, i)
      .map(range);

    if (
      currentRange === null ||
      previous.some(value => value === null)
    ) continue;

    const average = previous.reduce((sum, value) => sum + value, 0)
      / previous.length;

    if (average <= 0) continue;

    eligible++;

    const ratio = currentRange / average;
    if (ratio < threshold) continue;

    rangeSignals++;
    ratios.push(ratio);

    const body = Math.abs(num(current.close) - num(current.open));

    if (currentRange > 0 && body / currentRange >= BODY_RATIO_MIN) {
      bodySignals++;
    }
  }

  ratios.sort((a, b) => a - b);

  return {
    eligible,
    rangeSignals,
    bodySignals,
    medianRatio: ratios.length
      ? ratios[Math.floor(ratios.length / 2)]
      : null
  };
}

function printTable(rows) {
  const columns = [
    ["Threshold", 10],
    ["TF", 5],
    ["Eligible", 12],
    ["Range signals", 15],
    ["Body-filter signals", 21],
    ["Filtered out %", 16],
    ["Range signals / 1000", 22]
  ];

  console.log(columns.map(([name, width]) => name.padEnd(width)).join(""));
  console.log("-".repeat(columns.reduce((sum, [, width]) => sum + width, 0)));

  for (const row of rows) {
    const filtered = row.rangeSignals
      ? ((row.rangeSignals - row.bodySignals) / row.rangeSignals * 100)
      : 0;

    const rate = row.eligible
      ? row.rangeSignals / row.eligible * 1000
      : 0;

    const values = [
      row.threshold,
      row.timeframe,
      row.eligible,
      row.rangeSignals,
      row.bodySignals,
      `${filtered.toFixed(1)}%`,
      rate.toFixed(1)
    ];

    console.log(values.map((value, i) =>
      String(value).padEnd(columns[i][1])
    ).join(""));
  }
}

async function main() {
  if (!API_KEY) {
    console.error("Missing TWELVE_DATA_API_KEY.");
    console.error("Set it as a GitHub Actions secret. Do not put the key in this file.");
    process.exitCode = 1;
    return;
  }

  const pairs = PAIRS.slice(0, MAX_PAIRS);
  const datasets = new Map();

  console.log("HISTORICAL THRESHOLD TEST");
  console.log(`Pairs requested: ${pairs.join(", ")}`);
  console.log(`History: ${DAYS} days`);
  console.log(`Thresholds: ${THRESHOLDS.join(", ")}`);
  console.log(`Body filter: ${BODY_RATIO_MIN * 100}% of candle range`);
  console.log("Fetching historical data...\n");

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    console.log(`[${i + 1}/${pairs.length}] ${pair}`);

    try {
      const candles = await fetchCandles(pair);
      datasets.set(pair, candles);
      console.log(`  ${candles.length} completed 5m candles`);
    } catch (error) {
      console.error(`  FAILED: ${error.message}`);
    }
  }

  if (datasets.size === 0) {
    console.error("No data retrieved. Check the API key, credits and plan limits.");
    process.exitCode = 1;
    return;
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

  console.log("\nRESULTS — COMBINED ACROSS SUCCESSFULLY TESTED PAIRS\n");
  printTable(rows);

  console.log("\nPAIRS SUCCESSFULLY TESTED:", datasets.size, "of", pairs.length);
  console.log("\nHOW TO READ THE RESULTS");
  console.log("- Fewer range signals means a higher threshold is more selective.");
  console.log("- Body-filter signals are a subset of range signals.");
  console.log("- Filtered out % shows how many range signals fail the body filter.");
  console.log("- Range signals / 1000 normalizes signal counts by eligible candles.");
  console.log("- These are historical candle-expansion counts, not proof of institutional activity or predictive accuracy.");
  console.log("- This test does not change the live scanner.");

  if (datasets.size < pairs.length) {
    console.log("\nWARNING: Some pairs failed; results use only successfully retrieved pairs.");
  }
}

main().catch(error => {
  console.error("Test failed:", error.message);
  process.exitCode = 1;
});
