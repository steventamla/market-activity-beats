// Currency-level activity scanner
// Initial thresholds must be tested against historical data.

const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'JPY',
  'CHF', 'AUD', 'CAD', 'NZD'
];

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
const OUTPUT_SIZE = BASELINE_CANDLES + 2;

let latestScanData = {
  scan_timestamp: null,
  scan_status: 'never_run',
  error: null,
  active_signals_count: 0,
  active_currencies: [],
  currency_status: CURRENCIES.map(currency => ({
    currency,
    timeframes: Object.fromEntries(
      TIMEFRAMES.map(tf => [
        tf.label,
        {
          active: false,
          bias: null,
          last_active_at: null,
          agreeing_pairs: 0,
          expanding_pairs: 0,
          direction_share: 0,
          pairs: []
        }
      ])
    )
  })),
  credits_estimated: 0
};

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function candleRange(candle) {
  const high = toNumber(candle?.high);
  const low = toNumber(candle?.low);

  if (high === null || low === null || high < low) {
    return null;
  }

  return high - low;
}

function candleDirection(candle) {
  const open = toNumber(candle?.open);
  const close = toNumber(candle?.close);

  if (open === null || close === null || open === close) {
    return 0;
  }

  return close > open ? 1 : -1;
}

function parseBatch(data, symbols) {
  if (data?.values && data?.meta?.symbol) {
    return { [data.meta.symbol]: data };
  }

  const result = {};

  for (const symbol of symbols) {
    const item =
      data?.[symbol] ||
      data?.[symbol.replace('/', '')];

    if (Array.isArray(item?.values)) {
      result[symbol] = item;
    }
  }

  return result;
}

async function fetchBatch(symbols, interval, apiKey) {
  const url = new URL(
    'https://api.twelvedata.com/time_series'
  );

  url.searchParams.set('symbol', symbols.join(','));
  url.searchParams.set('interval', interval);
  url.searchParams.set('outputsize', String(OUTPUT_SIZE));
  url.searchParams.set('apikey', apiKey);

  const response = await fetch(url);
  const data = await response.json();

  if (
    !response.ok ||
    data?.status === 'error' ||
    data?.code
  ) {
    throw new Error(
      `${interval}: ${
        data?.message ||
        `Twelve Data HTTP ${response.status}`
      }`
    );
  }

  const parsed = parseBatch(data, symbols);

  const missing = symbols.filter(
    symbol => !parsed[symbol]
  );

  if (missing.length) {
    console.warn(
      `[scanner] Missing ${interval} data: ` +
      missing.join(', ')
    );
  }

  return parsed;
}

function inspectPair(symbol, series) {
  const values = series?.values;

  if (
    !Array.isArray(values) ||
    values.length < OUTPUT_SIZE
  ) {
    return null;
  }

  // Use the last completed candle, not the
  // potentially incomplete newest candle.
  const current = values[1];

  const baseline = values.slice(
    2,
    2 + BASELINE_CANDLES
  );

  const currentRange = candleRange(current);
  const ranges = baseline.map(candleRange);

  if (
    currentRange === null ||
    ranges.some(range => range === null)
  ) {
    return null;
  }

  const averageRange =
    ranges.reduce((sum, range) => sum + range, 0) /
    ranges.length;

  if (
    averageRange <= 0 ||
    currentRange < averageRange * RANGE_MULTIPLIER
  ) {
    return null;
  }

  const direction = candleDirection(current);

  if (direction === 0) {
    return null;
  }

  const [base, quote] = symbol.split('/');

  return {
    symbol,
    datetime: current.datetime || null,
    base,
    quote,
    baseDirection: direction,
    quoteDirection: -direction,
    rangeRatio: Number(
      (currentRange / averageRange).toFixed(2)
    )
  };
}

function scoreCurrency(currency, signals) {
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

  const bullish = votes.filter(
    vote => vote.direction === 1
  );

  const bearish = votes.filter(
    vote => vote.direction === -1
  );

  let direction = 0;

  if (bullish.length > bearish.length) {
    direction = 1;
  } else if (bearish.length > bullish.length) {
    direction = -1;
  }

  const dominant =
    direction === 1
      ? bullish
      : direction === -1
        ? bearish
        : [];

  const directionShare = votes.length
    ? dominant.length / votes.length
    : 0;

  const active =
    dominant.length >= MIN_EXPANSION_PAIRS &&
    directionShare >= MIN_DIRECTION_SHARE;

  const lastActiveAt = active
    ? dominant
        .map(vote => vote.datetime)
        .filter(Boolean)
        .sort()
        .at(-1) || null
    : null;

  return {
    active,
    bias: active
      ? direction === 1
        ? 'BUY'
        : 'SELL'
      : null,
    last_active_at: lastActiveAt,
    agreeing_pairs: dominant.length,
    expanding_pairs: votes.length,
    direction_share: Number(
      directionShare.toFixed(2)
    ),
    pairs: active
      ? dominant.map(vote => ({
          symbol: vote.symbol,
          range_ratio: vote.ratio,
          candle_time: vote.datetime
        }))
      : []
  };
}

async function executeMarketScan() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    latestScanData = {
      ...latestScanData,
      scan_timestamp: new Date().toISOString(),
      scan_status: 'error',
      error: 'Missing TWELVE_DATA_API_KEY environment variable.'
    };

    return latestScanData;
  }

  latestScanData = {
    ...latestScanData,
    scan_status: 'scanning',
    error: null
  };

  try {
    const rows = CURRENCIES.map(currency => ({
      currency,
      timeframes: {}
    }));

    for (const timeframe of TIMEFRAMES) {
      const seriesByPair = await fetchBatch(
        PAIRS,
        timeframe.api,
        apiKey
      );

      const signals = PAIRS
        .map(pair =>
          inspectPair(pair, seriesByPair[pair])
        )
        .filter(Boolean);

      for (const row of rows) {
        row.timeframes[timeframe.label] =
          scoreCurrency(row.currency, signals);
      }
    }

    const activeCurrencies = [];

    for (const row of rows) {
      for (const timeframe of TIMEFRAMES) {
        const result =
          row.timeframes[timeframe.label];

        if (result.active) {
          activeCurrencies.push({
            currency: row.currency,
            timeframe: timeframe.label,
            bias: result.bias,
            status: 'ACTIVE',
            cohesion:
              `${result.agreeing_pairs}/` +
              `${result.expanding_pairs} expanding pairs agree`,
            last_active_at: result.last_active_at,
            direction_share: result.direction_share,
            pairs: result.pairs
          });
        }
      }
    }

    latestScanData = {
      scan_timestamp: new Date().toISOString(),
      scan_status: 'success',
      error: null,
      active_signals_count: activeCurrencies.length,
      active_currencies: activeCurrencies,
      currency_status: rows,
      credits_estimated:
        PAIRS.length * TIMEFRAMES.length
    };
  } catch (error) {
    console.error('[scanner] Scan failed:', error);

    latestScanData = {
      ...latestScanData,
      scan_timestamp: new Date().toISOString(),
      scan_status: 'error',
      error: error.message
    };
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
