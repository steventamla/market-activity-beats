const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 7-Pair Basket Mapping for each Major Currency
const BASKET_MAP = {
  USD: ['EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD', 'USD/CAD', 'USD/CHF', 'USD/JPY'],
  EUR: ['EUR/USD', 'EUR/GBP', 'EUR/JPY', 'EUR/CHF', 'EUR/AUD', 'EUR/CAD', 'EUR/NZD'],
  GBP: ['GBP/USD', 'EUR/GBP', 'GBP/JPY', 'GBP/CHF', 'GBP/AUD', 'GBP/CAD', 'GBP/NZD'],
  AUD: ['AUD/USD', 'EUR/AUD', 'GBP/AUD', 'AUD/NZD', 'AUD/CAD', 'AUD/CHF', 'AUD/JPY'],
  NZD: ['NZD/USD', 'AUD/NZD', 'NZD/CAD', 'NZD/CHF', 'NZD/JPY'],
  CAD: ['USD/CAD', 'EUR/CAD', 'GBP/CAD', 'AUD/CAD', 'NZD/CAD', 'CAD/CHF', 'CAD/JPY'],
  CHF: ['USD/CHF', 'EUR/CHF', 'GBP/CHF', 'AUD/CHF', 'CAD/CHF', 'CHF/JPY'],
  JPY: ['USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'NZD/JPY', 'CAD/JPY', 'CHF/JPY']
};

const TIMEFRAMES = ['1min', '3min', '5min', '15min', '1h', '4h'];

app.get('/', (req, res) => {
  res.send('Market Activity Scanner is active');
});

// Main Endpoint: Scans all currencies and timeframes for institutional basket activity
app.get('/scan', async (req, res) => {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'TWELVE_DATA_API_KEY is not configured in environment variables.' });
  }

  const activeResults = [];

  try {
    // Loop through each major currency basket
    for (const [currency, pairs] of Object.entries(BASKET_MAP)) {
      
      // Loop through each required timeframe
      for (const tf of TIMEFRAMES) {
        let expandingPairsCount = 0;
        let bullishVotes = 0;
        let bearishVotes = 0;
        let latestCandleDetails = null;

        // Evaluate each pair in the basket concurrently for this timeframe
        const pairPromises = pairs.map(async (symbol) => {
          try {
            const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${tf}&outputsize=15&apikey=${apiKey}`;
            const response = await fetch(url);
            const data = await response.json();

            if (data.status === 'error' || !data.values || data.values.length < 15) return null;

            const candles = data.values;
            const latest = candles[0];
            
            // Calculate current candle range
            const high = parseFloat(latest.high);
            const low = parseFloat(latest.low);
            const open = parseFloat(latest.open);
            const close = parseFloat(latest.close);
            const currentRange = high - low;

            // Calculate ATR(14) baseline from prior candles
            const priorCandles = candles.slice(1, 15);
            const avgRange = priorCandles.reduce((sum, c) => sum + (parseFloat(c.high) - parseFloat(c.low)), 0) / priorCandles.length;

            // Volatility Expansion Condition (Threshold >= 1.8x ATR baseline)
            const isExpanding = currentRange >= (avgRange * 1.8);

            // Determine directional orientation relative to the base currency
            const isBaseCurrencyFirst = symbol.startsWith(currency);
            const isBullishCandle = close > open;
            
            let directionalBias = 'NEUTRAL';
            if (isExpanding) {
              if (isBaseCurrencyFirst) {
                directionalBias = isBullishCandle ? 'BUY' : 'SELL';
              } else {
                directionalBias = isBullishCandle ? 'SELL' : 'BUY'; // Inverse for quote pairs like EUR/GBP for GBP
              }
            }

            return {
              symbol,
              isExpanding,
              bias: directionalBias,
              datetime: latest.datetime
            };
          } catch (err) {
            return null;
          }
        });

        const pairResults = (await Promise.all(pairPromises)).filter(Boolean);

        if (pairResults.length === 0) continue;

        // Tally results across the basket
        pairResults.forEach(resItem => {
          if (resItem.isExpanding) {
            expandingPairsCount++;
            if (resItem.bias === 'BUY') bullishVotes++;
            if (resItem.bias === 'SELL') bearishVotes++;
          }
        });

        // Basket Cohesion Rule: At least 5 out of 7 (or majority for smaller baskets) must align
        const minRequiredPairs = Math.min(5, pairs.length);
        const dominantBias = bullishVotes > bearishVotes ? 'BUY' : 'SELL';
        const dominantVotes = Math.max(bullishVotes, bearishVotes);

        if (expandingPairsCount >= minRequiredPairs && dominantVotes >= minRequiredPairs) {
          activeResults.push({
            currency,
            timeframe: tf,
            bias: dominantBias,
            expanding_pairs_count: `${expandingPairsCount}/${pairs.length}`,
            detected_at: pairResults[0]?.datetime || 'Just now',
            status: 'ACTIVE_DISPLACEMENT'
          });
        }
      }
    }

    res.json({
      scan_timestamp: new Date().toISOString(),
      active_signals_found: activeResults.length,
      results: activeResults
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to execute institutional market scan.' });
  }
});

app.listen(PORT, () => {
  console.log(`Market Activity Scanner running on port ${PORT}`);
});
