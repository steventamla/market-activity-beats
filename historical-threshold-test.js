/**
 * Historical Threshold Test
 * Requires Node.js 18+ and TWELVE_DATA_API_KEY.
 * Run: node historical-threshold-test.js
 *
 * Optional:
 * TEST_DAYS=5 MAX_PAIRS=4 node historical-threshold-test.js
 *
 * This script is separate from the live scanner.
 */

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const DAYS = Math.max(2, Number.parseInt(process.env.TEST_DAYS || "5", 10));
const MAX_PAIRS = Math.max(1, Number.parseInt(process.env.MAX_PAIRS || "4", 10));

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
const FIVE_MIN = 5 * 60 * 1000;

const TIMEFRAMES = [
  { label: "5m", ms: 5 * 60 * 1000, n: 1 },
  { label: "15m", ms: 15 * 60 * 1000, n: 3 },
  { label: "1h", ms: 60 * 60 * 1000, n: 12 },
  { label: "4h", ms: 4 * 60 * 60 * 1000, n: 48 }
];

function candleTime(c) {
  if (!c?.datetime) return NaN;
  const s = String(c.datetime);
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z");
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function candleRange(c) {
  const h = num(c.high);
  const l = num(c.low);
  return h === null || l === null || h < l ? null : h - l;
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

  const response = await fetch(url);
  const data = await response.json();

  if (
    !response.ok ||
    data?.status === "error" ||
    data?.code ||
    !Array.isArray(data?.values)
  ) {
    throw new Error(data?.message || "Unexpected Twelve Data response");
  }

  return data.values
    .filter(c =>
      Number.isFinite(candleTime(c)) &&
      candleTime(c) + FIVE_MIN <= Date.now()
    )
    .sort((a, b) => candleTime(a) - candleTime(b));
}

function aggregateCandles(candles, tf) {
  if (tf.n === 1) return candles;

  const buckets = new Map();

  for (const c of candles) {
    const t = candleTime(c);
    const start = Math.floor(t / tf.ms) * tf.ms;

    if (!buckets.has(start)) buckets.set(start, new Map());
    buckets.get(start).set(t, c);
  }

  const result = [];

  for (const [start, bucket] of buckets) {
    const times = Array.from(
      { length: tf.n },
      (_, i) => start + i * FIVE_MIN
    );

    // Use only complete higher-timeframe candles.
    if (!times.every(t => bucket.has(t))) continue;

    const group = times.map(t => bucket.get(t));
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

  return result;
}

// Each candle is compared only with the 14 candles before it.
function testThreshold(candles, threshold) {
  let eligible = 0;
  let rangeSignals = 0;
  let bodySignals = 0;
  const ratios = [];

  for (let i = BASELINE; i < candles.length; i++) {
    const current = candles[i];
    const currentRange = candleRange(current);

    const previousRanges = candles
      .slice(i - BASELINE, i)
      .map(candleRange);

    if (
      currentRange === null ||
      previousRanges.some(r => r === null)
    ) continue;

    const average =
      previousRanges.reduce((sum, r) => sum + r, 0) /
      previousRanges.length;

    if (average <= 0) continue;

    eligible++;

    const ratio = currentRange / average;
    if (ratio < threshold) continue;

    rangeSignals++;
    ratios.push(ratio);

    const open = num(current.open);
    const close = num(current.close);
    const body = Math.abs(close - open);

    // Diagnostic only: body is at least 60% of full candle range.
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

async function main() {
  if (!API_KEY) {
    console.error("Missing TWELVE_DATA_API_KEY environment variable.");
    console.error(
      "Set it securely. Never paste your API key into this code or commit it to GitHub."
    );
    process.exitCode = 1;
    return;
  }

  const pairs = PAIRS.slice(0, Math.min(MAX_PAIRS, PAIRS.length));
  const data = new Map();

  console.log("Historical threshold test — read-only");
  console.log("Pairs:", pairs.join(", "));
  console.log("Requested history in days:", DAYS);
  console.log("Thresholds:", THRESHOLDS.join(", "));
  console.log("");

  for (const pair of pairs) {
    try {
      console.log("Fetching", pair);
      const candles = await fetchCandles(pair);
      data.set(pair, candles);
      console.log("  Completed 5m candles:", candles.length);
    } catch (error) {
      console.error("  FAILED:", pair, error.message);
    }
  }

  if (data.size === 0) {
    console.error("No data retrieved. Check API access, credits and symbols.");
    process.exitCode = 1;
    return;
  }

  console.log("\nRESULTS");
  console.log(
    "Threshold | TF | Eligible candles | Range signals | Body-filter signals | Median ratio"
  );
  console.log("-".repeat(84));

  for (const tf of TIMEFRAMES) {
    for (const threshold of THRESHOLDS) {
      let eligible = 0;
      let signals = 0;
      let bodySignals = 0;
      const medians = [];

      for (const candles of data.values()) {
        const aggregated = aggregateCandles(candles, tf);
        const result = testThreshold(aggregated, threshold);

        eligible += result.eligible;
        signals += result.rangeSignals;
        bodySignals += result.bodySignals;

        if (result.median !== null) medians.push(result.median);
      }

      medians.sort((a, b) => a - b);

      const median = medians.length
        ? medians[Math.floor(medians.length / 2)].toFixed(2)
        : "-";

      console.log(
        `${String(threshold).padEnd(9)} | ` +
        `${tf.label.padEnd(2)} | ` +
        `${String(eligible).padEnd(16)} | ` +
        `${String(signals).padEnd(13)} | ` +
        `${String(bodySignals).padEnd(19)} | ${median}`
      );
    }
  }

  console.log("\nTest complete.");
  console.log(
    "These are historical signal counts, not proof of institutional activity or predictive accuracy."
  );
  console.log(
    "The body filter is diagnostic only; it has not been applied to your live scanner."
  );
}

main().catch(error => {
  console.error("Test failed:", error.message);
  process.exitCode = 1;
});
