const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve the HTML Dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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

let latestScanData = {
  scan_timestamp: null,
  active_signals_count: 0,
  active_currencies: []
};

app.get('/latest-scan', (req, res) => {
  res.json(latestScanData);
});

// Manual trigger endpoint
app.get('/scan', async (req, res) => {
  await executeMarketScan();
  res.json(latestScanData);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function executeMarketScan() {
  const currentHour = new Date().getHours();
  if (currentHour < 6 || currentHour >= 23) {
    console.log(`Skipping scan. Outside operating hours (6 AM - 11 PM). Current hour: ${currentHour}`);
    return;
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    console.error('TWELVE_DATA_API_KEY is missing.');
    return;
  }

  console.log('Starting scheduled market activity scan...');
  const activeResults = [];

  try {
    for (const [currency, pairs] of Object.entries(BASKET_MAP)) {
      for (const tf of TIMEFRAMES) {
        const symbolsParam = pairs.join(',');
        const url = `https://api.twelvedata.com/time_series?symbol=${symbolsParam}&interval=${tf}&outputsize=15&apikey=${apiKey}`;
        
        const response = await fetch(url);
        const data = await response.json();

        const seriesData = data.status ? { [pairs[0]]: data } : data;

        let bullishVotes = 0;
        let bearishVotes = 0;
        let expandingPairsCount = 0;

        pairs.forEach((symbol) => {
          const pairObj = seriesData[symbol];
          if (!pairObj || !pairObj.values || pairObj.values.length < 15) return;

          const candles = pairObj.values;
          const current = candles[0];
          const previous = candles[1];

          const currentRange = parseFloat(current.high) - parseFloat(current.low);
          const previousRange = parseFloat(previous.high) - parseFloat(previous.low);

          const prior14 = candles.slice(1, 15);
          const avgRange = prior14.reduce((sum, c) => sum + (parseFloat(c.high) - parseFloat(c.low)), 0) / 14;

          const isCurrentExpanding = currentRange >= (avgRange * 1.8);
          const isPreviousExpanding = previousRange >= (avgRange * 1.8);
          
          if (isCurrentExpanding || isPreviousExpanding) {
            expandingPairsCount++;

            const targetCandle = isCurrentExpanding ? current : previous;
            const isBullish = parseFloat(targetCandle.close) >= parseFloat(targetCandle.open);
            const isBase = symbol.startsWith(currency);

            let bias = 'NEUTRAL';
            if (isBase) {
              bias = isBullish ? 'BUY' : 'SELL';
            } else {
              bias = isBullish ? 'SELL' : 'BUY';
            }

            if (bias === 'BUY') bullishVotes++;
            if (bias === 'SELL') bearishVotes++;
          }
        });

        const minRequired = Math.min(5, pairs.length);
        const dominantBias = bullishVotes > bearishVotes ? 'BUY' : 'SELL';
        const dominantVotes = Math.max(bullishVotes, bearishVotes);

        if (expandingPairsCount >= minRequired && dominantVotes >= minRequired) {
          activeResults.push({
            currency,
            timeframe: tf,
            bias: dominantBias,
            cohesion: `${dominantVotes}/${pairs.length} pairs aligned`,
            status: 'ACTIVE_DISPLACEMENT'
          });
        }

        await sleep(200);
      }
    }

    latestScanData = {
      scan_timestamp: new Date().toISOString(),
      active_signals_count: activeResults.length,
      active_currencies: activeResults
    };

    console.log(`Scan completed. Found ${activeResults.length} active signals.`);

  } catch (error) {
    console.error('Error during market scan:', error);
  }
}

// Run every 1 hour
const ONE_HOUR = 60 * 60 * 1000;
setInterval(executeMarketScan, ONE_HOUR);

app.listen(PORT, () => {
  console.log(`Market Activity Scanner active on port ${PORT}`);
});
