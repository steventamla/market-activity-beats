const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];

const TIMEFRAMES = [
  { api: '15min', label: '15m' },
  { api: '1h', label: '1h' }
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

const RANGE_MULTIPLIER = 1.5;
const BASELINE_CANDLES = 14;
const MIN_EXPANSION_PAIRS = 3;
const MIN_DIRECTION_SHARE = 0.60;
const BATCH_SIZE = 7;
const BATCH_DELAY_MS = 61000;
const OUTPUT_SIZE = 100;
const HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

let scanInProgress = false;
const lastActiveMemory = {};

function emptyTimeframe() {
  return {
    active: false,
    bias: null,
    last_active_at: null,
    agreeing_pairs: 0,
    expanding_pairs: 0,
    direction_share: 0,
    pairs: []
  };
}

let latestScanData = {
  scan_timestamp: null,
  scan_status: 'never_run',
  error: null,
  active_signals_count: 0,
  active_currencies: [],
  currency_status: CURRENCIES.map(currency => ({
    currency,
    timeframes: {
      '15m': emptyTimeframe(),
      '1h': emptyTimeframe()
    }
  })),
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

function candleDirection(candle) {
  const open = toNumber(candle?.open);
  const close = toNumber(candle?.close);

  if (open === null || close === null || open === close) return 0;
  return close > open ? 1 : -1;
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
    const item = data?.[symbol] ||
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
  url.searchParams.set('interval', '15min');
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

function completed15mCandles(series, now = Date.now()) {
  const values = Array.isArray(series?.values) ? series.values : [];

  return values
    .filter(candle => {
      const time = candleTime(candle);
      return Number.isFinite(time) && time + FIFTEEN_MIN_MS <= now;
    })
    .sort((a, b) => candleTime(b) - candleTime(a));
}

function makeHourlyCandles(candles) {
  const buckets = new Map();

  for (const candle of candles) {
    const time = candleTime(candle);
    if (!Number.isFinite(time)) continue;

    const hourStart = Math.floor(time / HOUR_MS) * HOUR_MS;

    if (!buckets.has(hourStart)) buckets.set(hourStart, []);
    buckets.get(hourStart).push(candle);
  }

  const hourly = [];

  for (const [hourStart, items] of buckets.entries()) {
    const unique = new Map(items.map(item => [candleTime(item), item]));

    const expected = [
      hourStart,
      hourStart + FIFTEEN_MIN_MS,
      hourStart + 2 * FIFTEEN_MIN_MS,
      hourStart + 3 * FIFTEEN_MIN_MS
    ];

    if (!expected.every(time => unique.has(time))) continue;

    const ordered = expected.map(time => unique.get(time));
    const first = ordered[0];
    const last = ordered[3];
    const highs = ordered.map(item => toNumber(item.high));
    const lows = ordered.map(item => toNumber(item.low));

    if (
      toNumber(first.open) === null ||
      toNumber(last.close) === null ||
      highs.some(value => value === null) ||
      lows.some(value => value === null)
    ) continue;

    hourly.push({
      datetime: new Date(hourStart).toISOString(),
      open: first.open,
      high: Math.max(...highs),
      low: Math.min(...lows),
      close: last.close
    });
  }

  return hourly.sort((a, b) => candleTime(b) - candleTime(a));
}

function inspectCandles(symbol, candles) {
  if (!Array.isArray(candles) || candles.length < BASELINE_CANDLES + 1) {
    return null;
  }

  const current = candles[0];
  const baseline = candles.slice(1, BASELINE_CANDLES + 1);
  const currentRange = candleRange(current);
  const baselineRanges = baseline.map(candleRange);

  if (
    currentRange === null ||
    baselineRanges.some(range => range === null)
  ) return null;

  const averageRange =
    baselineRanges.reduce((sum, range) => sum + range, 0) /
    baselineRanges.length;

  if (
    averageRange <= 0 ||
    currentRange < averageRange * RANGE_MULTIPLIER
  ) return null;

  const direction = candleDirection(current);
  if (direction === 0) return null;

  const [base, quote] = symbol.split('/');

  return {
    symbol,
    datetime: current.datetime || null,
    base,
    quote,
    baseDirection: direction,
    quoteDirection: -direction,
    rangeRatio: Number((currentRange / averageRange).toFixed(2))
  };
}

function scoreCurrency(currency, signals, timeframeLabel) {
  const votes = [];

  for (const signal of signals) {
    if (signal.base === currency) {
      votes.push({
        direction: signal.baseDirection,
        symbol: signal.symbol,
        ratio: signal.rangeRatio,
        datetime: signal.datetime
      });
    }

    if (signal.quote === currency) {
      votes.push({
        direction: signal.quoteDirection,
        symbol: signal.symbol,
        ratio: signal.rangeRatio,
        datetime: signal.datetime
      });
    }
  }

  const bullish = votes.filter(vote => vote.direction === 1);
  const bearish = votes.filter(vote => vote.direction === -1);

  const direction = bullish.length > bearish.length
    ? 1
    : bearish.length > bullish.length
      ? -1
      : 0;

  const dominant = direction === 1
    ? bullish
    : direction === -1
      ? bearish
      : [];

  const directionShare = votes.length ? dominant.length / votes.length : 0;

  const active =
    dominant.length >= MIN_EXPANSION_PAIRS &&
    directionShare >= MIN_DIRECTION_SHARE;

  const key = `${currency}|${timeframeLabel}`;
  const currentActiveAt = active
    ? dominant.map(vote => vote.datetime).filter(Boolean).sort().at(-1) || null
    : null;

  if (currentActiveAt) lastActiveMemory[key] = currentActiveAt;

  return {
    active,
    bias: active ? (direction === 1 ? 'BUY' : 'SELL') : null,
    last_active_at: currentActiveAt || lastActiveMemory[key] || null,
    agreeing_pairs: dominant.length,
    expanding_pairs: votes.length,
    direction_share: Number(directionShare.toFixed(2)),
    pairs: active ? dominant.map(vote => ({
      symbol: vote.symbol,
      range_ratio: vote.ratio,
      candle_time: vote.datetime
    })) : []
  };
}

async function executeMarketScan() {
  if (scanInProgress) {
    return { ...latestScanData, scan_status: 'scanning' };
  }
    const day = new Date().getUTCDay();
    if (day === 0 || day === 6) {
      return {
        ...latestScanData,
        scan_timestamp: new Date().toISOString(),
        scan_status: 'success',
        error: null,
        active_signals_count: 0,
        active_currencies: [],
        message: 'Forex market closed for the weekend.'
      };
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
      Object.assign(seriesByPair, await fetchBatch(batch, apiKey));

      if (start + BATCH_SIZE < PAIRS.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    const rows = CURRENCIES.map(currency => ({
      currency,
      timeframes: {}
    }));

    const signals15m = [];
    const signals1h = [];

    for (const pair of PAIRS) {
      const completed = completed15mCandles(seriesByPair[pair]);

      const signal15m = inspectCandles(pair, completed);
      if (signal15m) signals15m.push(signal15m);

      const hourly = makeHourlyCandles(completed);
      const signal1h = inspectCandles(pair, hourly);
      if (signal1h) signals1h.push(signal1h);
    }

    for (const row of rows) {
      row.timeframes['15m'] = scoreCurrency(row.currency, signals15m, '15m');
      row.timeframes['1h'] = scoreCurrency(row.currency, signals1h, '1h');
    }

    const activeCurrencies = [];

    for (const row of rows) {
      for (const timeframe of TIMEFRAMES) {
        const result = row.timeframes[timeframe.label];
        if (!result.active) continue;

        activeCurrencies.push({
          currency: row.currency,
          timeframe: timeframe.label,
          bias: result.bias,
          status: 'ACTIVE',
          cohesion: `${result.agreeing_pairs}/${result.expanding_pairs} expanding pairs agree`,
          last_active_at: result.last_active_at,
          direction_share: result.direction_share,
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
      credits_estimated: PAIRS.length
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

