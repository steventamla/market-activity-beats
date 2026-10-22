
'use strict';

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

// Final candidate settings from the historical threshold test.
const ATR_PERIOD = 14;
const ATR_MULTIPLIER = 2.0;
const MIN_BODY_RATIO = 0.60;

const MIN_EXPANSION_PAIRS = 1; // Preserve one-pair early detection.
// Four symbols per request stays below the free plan's 8 credits/minute
// when requests are separated by the 61-second delay below.
const BATCH_SIZE = 4;
const BATCH_DELAY_MS = 61000;
const OUTPUT_SIZE = 1200;
const FIVE_MIN_MS = 5 * 60 * 1000;

let scanInProgress = false;
const lastActiveMemory = {};

function emptyTimeframe() {
  return {
    active: false,
    last_active_at: null,
    expanding_pairs: 0,
    pairs: []
  };
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
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
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
      symbol =>
        symbol.toUpperCase() === String(data.meta.symbol).toUpperCase()
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
        String(value?.meta?.symbol || '').toUpperCase() ===
        symbol.toUpperCase()
      );

    if (Array.isArray(item?.values)) {
      result[symbol] = item;
    }
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
    throw new Error(
      data?.message || `Twelve Data HTTP ${response.status}`
    );
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

// Build only fully completed higher-timeframe candles.
// Input and output are ordered newest first.
function aggregateCandles(fiveMinuteCandles, timeframe) {
  if (timeframe.candlesPerBucket === 1) {
    return fiveMinuteCandles;
  }

  const buckets = new Map();

  for (const candle of fiveMinuteCandles) {
    const time = candleTime(candle);
    if (!Number.isFinite(time)) continue;

    const bucketStart = Math.floor(time / timeframe.ms) * timeframe.ms;

    if (!buckets.has(bucketStart)) {
      buckets.set(bucketStart, new Map());
    }

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
    ) {
      continue;
    }

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

// Calculate Wilder ATR over historical candles.
// Input is ordered newest first; output is ATR known before candle[0].
// The current candle is excluded from the ATR calculation.
function calculatePriorATR(candles) {
  if (!Array.isArray(candles) || candles.length < ATR_PERIOD + 2) {
    return null;
  }

  const older = candles.slice(1).reverse();
  const ranges = [];

  for (let i = 0; i < older.length; i++) {
    const previousClose =
      i > 0 ? toNumber(older[i - 1].close) : null;

    const range = trueRange(older[i], previousClose);

    if (range === null) return null;

    ranges.push(range);
  }

  // Standard Wilder ATR: seed with the first 14 valid historical
  // true ranges, then smooth every remaining historical range.
  if (ranges.length < ATR_PERIOD) return null;

  const seed = ranges.slice(0, ATR_PERIOD);

  let atr = seed.reduce((sum, value) => sum + value, 0) / ATR_PERIOD;

  for (let i = ATR_PERIOD; i < ranges.length; i++) {
    atr = (
      (atr * (ATR_PERIOD - 1)) + ranges[i]
    ) / ATR_PERIOD;
  }

  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function inspectCandles(symbol, candles, timeframeMs) {
  if (!Array.isArray(candles) || candles.length < ATR_PERIOD + 2) {
    return null;
  }

  const current = candles[0];

  // An impulse may form across one candle or several consecutive candles.
  // Test the shortest qualifying run first, up to six candles. A run must
  // make a large net directional move relative to prior ATR and show enough
  // directional efficiency to avoid counting choppy back-and-forth movement.
  const MAX_IMPULSE_CANDLES = 24;
  const MIN_NET_MOVE_ATR = 2.0;
  const MIN_DIRECTIONAL_EFFICIENCY = 0.60;

  for (let count = 1; count <= MAX_IMPULSE_CANDLES; count++) {
    const run = candles.slice(0, count); // newest first

    if (run.length !== count) break;

    // Measure the impulse against volatility that existed before this run,
    // not ATR already inflated by candles inside the impulse itself.
    const priorCandles = candles.slice(count);
    const atr = calculatePriorATR(priorCandles);
    if (atr === null) continue;

    const oldest = run[run.length - 1];
    const oldestOpen = toNumber(oldest.open);
    const newestClose = toNumber(run[0].close);

    if (oldestOpen === null || newestClose === null) continue;

    const netMove = newestClose - oldestOpen;
    if (netMove === 0 || Math.abs(netMove) < MIN_NET_MOVE_ATR * atr) {
      continue;
    }

    const totalTravel = run.reduce((sum, candle) => {
      const open = toNumber(candle.open);
      const close = toNumber(candle.close);
      return open === null || close === null
        ? sum
        : sum + Math.abs(close - open);
    }, 0);

    const efficiency = totalTravel > 0
      ? Math.abs(netMove) / totalTravel
      : 0;

    if (efficiency < MIN_DIRECTIONAL_EFFICIENCY) continue;

    const [base, quote] = symbol.split('/');
    const startTime = candleTime(oldest);
    const endTime = candleTime(current);
    const totalRange = run.reduce((sum, candle) => {
      const range = candleRange(candle);
      return sum + (range === null ? 0 : range);
    }, 0);

    return {
      symbol,
      datetime: Number.isFinite(endTime)
        ? new Date(endTime + timeframeMs).toISOString()
        : null,
      impulse_start_at: Number.isFinite(startTime)
        ? new Date(startTime).toISOString()
        : null,
      impulse_candles: count,
      base,
      quote,
      rangeRatio: Number((Math.abs(netMove) / atr).toFixed(2)),
      bodyRatio: Number(efficiency.toFixed(2)),
      direction: netMove > 0 ? 'bullish' : 'bearish'
    };
  }

  return null;
}

function scoreCurrency(currency, signals, timeframeLabel) {
  const matchingPairs = signals.filter(
    signal => signal.base === currency || signal.quote === currency
  );

  const active = matchingPairs.length >= MIN_EXPANSION_PAIRS;

  // A bullish base/quote pair supports base strength and quote weakness;
  // a bearish pair supports base weakness and quote strength.
  const votes = matchingPairs.map(signal => ({
    symbol: signal.symbol,
    direction: signal.direction,
    vote: signal.base === currency
      ? (signal.direction === 'bullish' ? 1 : -1)
      : (signal.direction === 'bullish' ? -1 : 1)
  }));
  const strengthScore = votes.reduce((sum, item) => sum + item.vote, 0);
  const supportingPairs = votes.filter(item => item.vote === Math.sign(strengthScore)).length;
  const opposingPairs = votes.length - supportingPairs;
  const agreement = matchingPairs.length === 0 ? 'inactive'
    : matchingPairs.length === 1 ? 'early'
    : strengthScore === 0 ? 'conflicting'
    : opposingPairs === 0 ? 'confirmed'
    : supportingPairs > opposingPairs ? 'developing'
    : 'conflicting';

  const impactStars =
    agreement === 'confirmed' && matchingPairs.length >= 3 ? 3 :
    agreement === 'confirmed' || agreement === 'developing' ? 2 :
    matchingPairs.length >= 1 ? 1 : 0;

  const impactLabel =
    agreement === 'confirmed' ? 'Confirmed agreement' :
    agreement === 'developing' ? 'Developing agreement' :
    agreement === 'conflicting' ? 'Conflicting pairs' :
    agreement === 'early' ? 'Early activity' :
    'Inactive';

  const key = `${currency}|${timeframeLabel}`;

  const currentActiveAt = active
    ? matchingPairs
        .map(signal => signal.datetime)
        .filter(Boolean)
        .sort()
        .at(-1) || null
    : null;

  if (currentActiveAt) {
    lastActiveMemory[key] = currentActiveAt;
  }

  return {
    active,
    impact_stars: impactStars,
    impact_label: impactLabel,
    last_active_at: currentActiveAt || lastActiveMemory[key] || null,
    expanding_pairs: matchingPairs.length,
    agreement,
    strength_score: strengthScore,
    supporting_pairs: supportingPairs,
    opposing_pairs: opposingPairs,
    direction: strengthScore > 0 ? 'strong' : strengthScore < 0 ? 'weak' : 'mixed',
    pairs: active
      ? matchingPairs.map(signal => ({
          symbol: signal.symbol,
          range_ratio: signal.rangeRatio,
          body_ratio: signal.bodyRatio,
          candle_time: signal.datetime,
          impulse_start_at: signal.impulse_start_at || signal.datetime,
          impulse_candles: signal.impulse_candles || 1,
          pair_direction: signal.direction,
          currency_vote: signal.base === currency
            ? (signal.direction === 'bullish' ? 'supports_strength' : 'supports_weakness')
            : (signal.direction === 'bullish' ? 'supports_weakness' : 'supports_strength')
        }))
      : []
  };
}

async function executeMarketScan() {
  if (scanInProgress) {
    return { ...latestScanData, scan_status: 'scanning' };
  }

  // Avoid API requests when Forex is closed on weekends (UTC).
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
  latestScanData = {
    ...latestScanData,
    scan_status: 'scanning',
    error: null
  };

  try {
    const seriesByPair = {};

    for (let start = 0; start < PAIRS.length; start += BATCH_SIZE) {
      const batch = PAIRS.slice(start, start + BATCH_SIZE);

      Object.assign(
        seriesByPair,
        await fetchBatch(batch, apiKey)
      );

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

        if (signal) {
          signalsByTimeframe[timeframe.label].push(signal);
        }
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
          agreement: result.agreement,
          strength_score: result.strength_score,
          supporting_pairs: result.supporting_pairs,
          opposing_pairs: result.opposing_pairs,
          direction: result.direction,
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
        method: 'Wilder ATR',
        atr_period: ATR_PERIOD,
        atr_multiplier: ATR_MULTIPLIER,
        min_body_ratio: MIN_BODY_RATIO,
        impulse_detection: 'consecutive-candle net displacement',
        max_impulse_candles: 24,
        min_directional_efficiency: 0.60
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
