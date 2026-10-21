
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];

const TIMEFRAMES = [
  { label: '5m', ms: 5 * 60 * 1000, candlesPerBucket: 1 },
  { label: '15m', ms: 15 * 60 * 1000, candlesPerBucket: 3 },
  { label: '1h', ms: 60 * 60 * 1000, candlesPerBucket: 12 },
  { label: '4h', ms: 4 * 60 * 60 * 1000, candlesPerBucket: 48 }
];

const PAIRS = [
  'EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD',
  'USD/CAD', 'USD/CHF', 'USD/JPY',
  'EUR/GBP', 'EUR/JPY', 'EUR/CHF',
  'EUR/AUD', 'EUR/CAD', 'EUR/NZD',
  'GBP/JPY', 'GBP/CHF', 'GBP/AUD',
  'GBP/CAD', 'GBP/NZD',
  'AUD/NZD', 'AUD/CAD', 'AUD/CHF', 'AUD/JPY',
  'NZD/CAD', 'NZD/CHF', 'NZD/JPY',
  'CAD/CHF', 'CAD/JPY', 'CHF/JPY'
];

// Detection settings selected from the historical ATR threshold test.
const ATR_PERIOD = 14;
const ATR_MULTIPLIER = 2.0;
const MIN_BODY_RATIO = 0.60;

const MIN_EXPANSION_PAIRS = 1;
const BATCH_SIZE = 7;
const BATCH_DELAY_MS = 61000;
const OUTPUT_SIZE = 1200;
const FIVE_MIN_MS = 5 * 60 * 1000;

let scanInProgress = false;
const lastActiveMemory = {};

function emptyTimeframe() {
  return { active: false, last_active_at: null, expanding_pairs: 0, pairs: [] };
}

function emptyCurrencyStatus() {
  return CURRENCIES.map(currency => ({
    currency,
    timeframes: Object.fromEntries(
      TIMEFRAMES.map(tf => [tf.label, emptyTimeframe()])
    )
  }));
}

let latestScanData = {
  scan_timestamp: null,
  scan_status: 'never_run',
  error: null,
  active_signals_count: 0,
  active_currencies: [],
  currency_status: emptyCurrencyStatus(),
  credits_estimated: 0
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function candleRange(candle) {
  const high = toNumber(candle?.high);
  const low = toNumber(candle?.low);

  if (high === null || low === null || high < low) return null;
  return high - low;
}

function candleTime(candle) {
  if (!candle?.datetime) return NaN;

  const raw = String(candle.datetime);
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');

  return Date.parse(
    /[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`
  );
}

function parseBatch(data, symbols) {
  if (Array.isArray(data?.values) && data?.meta?.symbol) {
    const match = symbols.find(
      symbol => symbol.toUpperCase() === String(data.meta.symbol).toUpperCase()
    );
    return match ? { [match]: data } : {};
  }

  const result = {};
  const dataKeys = Object.keys(data || {});

  for (const symbol of symbols) {
    const item =
      data?.[symbol] ||
      data?.[symbol.replace('/', '')] ||
      dataKeys.map(key => data[key]).find(value =>
        String(value?.meta?.symbol || '').toUpperCase() === symbol.toUpperCase()
      );

    if (Array.isArray(item?.values)) result[symbol] = item;
  }

  return result;
}

async function fetchBatch(symbols, apiKey) {
  const url = new URL('https://api.twelvedata.com/time_series');

  url.searchParams.set('symbol', symbols.join(','));
  url.searchParams.set('interval', '5min');
  url.searchParams.set('outputsize', String(OUTPUT_SIZE));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('apikey', apiKey);

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data?.status === 'error' || data?.code) {
    throw new Error(data?.message || `Twelve Data HTTP ${response.status}`);
  }

  const parsed = parseBatch(data, symbols);
  const missing = symbols.filter(symbol => !parsed[symbol]);

  if (missing.length) {
    throw new Error(`Missing Twelve Data series: ${missing.join(', ')}`);
  }

  return parsed;
}

function completedFiveMinuteCandles(series, now = Date.now()) {
  const values = Array.isArray(series?.values) ? series.values : [];

  return values.filter(candle => {
    const time = candleTime(candle);
    return Number.isFinite(time) && time + FIVE_MIN_MS <= now;
  }).sort((a, b) => candleTime(b) - candleTime(a));
}

// Aggregate only complete 15m, 1h and 4h candles.
function aggregateCandles(fiveMinuteCandles, timeframe) {
  if (timeframe.candlesPerBucket === 1) return fiveMinuteCandles;

  const buckets = new Map();

  for (const candle of fiveMinuteCandles) {
    const time = candleTime(candle);
    if (!Number.isFinite(time)) continue;

    const bucketStart = Math.floor(time / timeframe.ms) * timeframe.ms;

    if (!buckets.has(bucketStart)) buckets.set(bucketStart, new Map());
    buckets.get(bucketStart).set(time, candle);
  }

  const aggregated = [];

  for (const [bucketStart, items] of buckets.entries()) {
    const expected = Array.from(
      { length: timeframe.candlesPerBucket },
      (_, i) => bucketStart + i * FIVE_MIN_MS
    );

    if (!expected.every(time => items.has(time))) continue;

    const ordered = expected.map(time => items.get(time));
    const highs = ordered.map(item => toNumber(item.high));
    const lows = ordered.map(item => toNumber(item.low));
    const open = toNumber(ordered[0].open);
    const close = toNumber(ordered[ordered.length - 1].close);

    if (
      open === null ||
      close === null ||
      highs.some(value => value === null) ||
      lows.some(value => value === null)
    ) continue;

    aggregated.push({
      datetime: new Date(bucketStart).toISOString(),
      open,
      high: Math.max(...highs),
      low: Math.min(...lows),
      close
    });
  }

  return aggregated.sort((a, b) => candleTime(b) - candleTime(a));
}

function trueRange(candle, previousClose) {
  const high = toNumber(candle?.high);
  const low = toNumber(candle?.low);

  if (high === null || low === null || high < low) return null;

  if (previousClose === null || previousClose === undefined) {
    return high - low;
  }

  return Math.max(
    high - low,
    Math.abs(high - previousClose),
    Math.abs(low - previousClose)
  );
}

// Calculate ATR(14) from the 14 completed candles BEFORE the current candle.
// The candles passed to this engine are ordered newest first.
function calculatePriorATR(candles) {
  if (!Array.isArray(candles) || candles.length < ATR_PERIOD + 2) {
    return null;
  }

  // Take 14 prior candles plus one older candle for previous-close calculations.
  const older = candles.slice(1, ATR_PERIOD + 2).reverse();
  const ranges = [];

  for (let i = 1; i < older.length; i++) {
    const previousClose = toNumber(older[i - 1].close);
    const range = trueRange(older[i], previousClose);

    if (range === null || previousClose === null) return null;
    ranges.push(range);
  }

  if (ranges.length !== ATR_PERIOD) return null;

  // The historical test uses the mean of the prior 14 true ranges.
  return ranges.reduce((sum, value) => sum + value, 0) / ATR_PERIOD;
}

function inspectCandles(symbol, candles, timeframeMs) {
  if (!Array.isArray(candles) || candles.length < ATR_PERIOD + 2) {
    return null;
  }

  const current = candles[0];
  const currentRange = candleRange(current);
  const open = toNumber(current.open);
  const close = toNumber(current.close);
  const atr = calculatePriorATR(candles);

  if (
    currentRange === null ||
    currentRange <= 0 ||
    open === null ||
    close === null ||
    atr === null ||
    atr <= 0
  ) {
    return null;
  }

  // Require current candle range to be at least 2x prior ATR.
  const rangeRatio = currentRange / atr;
  if (rangeRatio < ATR_MULTIPLIER) return null;

  // Require candle body to be at least 60% of the full high-low range.
  const bodyRatio = Math.abs(close - open) / currentRange;
  if (bodyRatio < MIN_BODY_RATIO) return null;

  const [base, quote] = symbol.split('/');
  const candleOpenTime = candleTime(current);

  return {
    symbol,
    datetime: Number.isFinite(candleOpenTime)
      ? new Date(candleOpenTime + timeframeMs).toISOString()
      : null,
    base,
    quote,
    rangeRatio: Number(rangeRatio.toFixed(2)),
    bodyRatio: Number(bodyRatio.toFixed(2))
  };
}

function scoreCurrency(currency, signals, timeframeLabel) {
  // Activity is counted regardless of pair direction.
  const matchingPairs = signals.filter(
    signal => signal.base === currency || signal.quote === currency
  );

  const active = matchingPairs.length >= MIN_EXPANSION_PAIRS;
  const impactStars =
    matchingPairs.length >= 6 ? 3 :
    matchingPairs.length >= 3 ? 2 :
    matchingPairs.length >= 1 ? 1 : 0;

  const impactLabel =
    impactStars === 3 ? 'High impact' :
    impactStars === 2 ? 'Moderate impact' :
    impactStars === 1 ? 'Early activity' : 'Inactive';

  const key = `${currency}|${timeframeLabel}`;

  const currentActiveAt = active
    ? matchingPairs
        .map(signal => signal.datetime)
        .filter(Boolean)
        .sort()
        .at(-1) || null
    : null;

  if (currentActiveAt) lastActiveMemory[key] = currentActiveAt;

  return {
    active,
    impact_stars: impactStars,
    impact_label: impactLabel,
    last_active_at: currentActiveAt || lastActiveMemory[key] || null,
    expanding_pairs: matchingPairs.length,
    pairs: active
      ? matchingPairs.map(signal => ({
          symbol: signal.symbol,
          range_ratio: signal.rangeRatio,
          body_ratio: signal.bodyRatio,
          candle_time: signal.datetime
        }))
      : []
  };
}

async function executeMarketScan() {
  if (scanInProgress) {
    return { ...latestScanData, scan_status: 'scanning' };
  }

  // Avoid API use when Forex is closed on Saturday/Sunday UTC.
  const utcDay = new Date().getUTCDay();

  if (utcDay === 0 || utcDay === 6) {
    latestScanData = {
      ...latestScanData,
      scan_timestamp: new Date().toISOString(),
      scan_status: 'success',
      error: null,
      active_signals_count: 0,
      active_currencies: [],
      currency_status: emptyCurrencyStatus(),
      credits_estimated: 0,
      message: 'Forex market closed for the weekend.'
    };

    return latestScanData;
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    latestScanData = {
      ...latestScanData,
      scan_timestamp: new Date().toISOString(),
      scan_status: 'error',
      error: 'Missing TWELVE_DATA_API_KEY environment variable.',
      active_signals_count: 0,
      active_currencies: []
    };

    return latestScanData;
  }

  scanInProgress = true;
  latestScanData = { ...latestScanData, scan_status: 'scanning', error: null };

  try {
    const seriesByPair = {};

    for (let start = 0; start < PAIRS.length; start += BATCH_SIZE) {
      const batch = PAIRS.slice(start, start + BATCH_SIZE);
      Object.assign(seriesByPair, await fetchBatch(batch, apiKey));

      if (start + BATCH_SIZE < PAIRS.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    const rows = emptyCurrencyStatus();
    const signalsByTimeframe = Object.fromEntries(
      TIMEFRAMES.map(tf => [tf.label, []])
    );

    for (const pair of PAIRS) {
      const fiveMinute = completedFiveMinuteCandles(seriesByPair[pair]);

      for (const timeframe of TIMEFRAMES) {
        const candles = aggregateCandles(fiveMinute, timeframe);
        const signal = inspectCandles(pair, candles, timeframe.ms);

        if (signal) signalsByTimeframe[timeframe.label].push(signal);
      }
    }

    for (const row of rows) {
      for (const timeframe of TIMEFRAMES) {
        row.timeframes[timeframe.label] = scoreCurrency(
          row.currency,
          signalsByTimeframe[timeframe.label],
          timeframe.label
        );
      }
    }

    const activeCurrencies = [];

    for (const row of rows) {
      for (const timeframe of TIMEFRAMES) {
        const result = row.timeframes[timeframe.label];
        if (!result.active) continue;

        activeCurrencies.push({
          currency: row.currency,
          timeframe: timeframe.label,
          status: 'ACTIVE',
          impact_stars: result.impact_stars,
          impact_label: result.impact_label,
          last_active_at: result.last_active_at,
          expanding_pairs: result.expanding_pairs,
          pairs: result.pairs
        });
      }
    }

    latestScanData = {
      scan_timestamp: new Date().toISOString(),
      scan_status: 'success',
      error: null,
      active_signals_count: activeCurrencies.length,
      active_currencies: activeCurrencies,
      currency_status: rows,
      credits_estimated: PAIRS.length,
      timeframes_analysed: TIMEFRAMES.map(tf => tf.label),
      detection_settings: {
        method: 'ATR',
        atr_period: ATR_PERIOD,
        atr_multiplier: ATR_MULTIPLIER,
        min_body_ratio: MIN_BODY_RATIO
      }
    };
  } catch (error) {
    console.error('[scanner] Scan failed:', error);

    latestScanData = {
      ...latestScanData,
      scan_timestamp: new Date().toISOString(),
      scan_status: 'error',
      error: error.message,
      active_signals_count: 0,
      active_currencies: []
    };
  } finally {
    scanInProgress = false;
  }

  return latestScanData;
}

module.exports = {
  CURRENCIES,
  PAIRS,
  TIMEFRAMES,
  executeMarketScan,
  getLatestScanData: () => latestScanData
};
