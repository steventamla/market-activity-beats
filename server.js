const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve the Dashboard directly
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Institutional Market Activity Scanner</title>
    <style>
        :root {
            --bg-primary: #0a0d14;
            --bg-secondary: #121824;
            --bg-card: #182232;
            --text-main: #f0f4f8;
            --text-muted: #8a99ad;
            --accent-green: #00e676;
            --accent-green-bg: rgba(0, 230, 118, 0.15);
            --accent-red: #ff3d00;
            --accent-red-bg: rgba(255, 61, 0, 0.15);
            --border-color: #233145;
            --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background-color: var(--bg-primary); color: var(--text-main); padding: 24px; min-height: 100vh; }
        header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 20px; border-bottom: 1px solid var(--border-color); margin-bottom: 24px; }
        .title-block h1 { font-size: 1.5rem; color: var(--text-main); }
        .title-block p { color: var(--text-muted); font-size: 0.85rem; margin-top: 4px; }
        .status-badge { display: flex; align-items: center; gap: 8px; background: var(--bg-secondary); border: 1px solid var(--border-color); padding: 8px 16px; border-radius: 20px; font-size: 0.85rem; }
        .indicator { width: 10px; height: 10px; border-radius: 50%; background-color: var(--accent-green); box-shadow: 0 0 10px var(--accent-green); }
        .controls-bar { display: flex; gap: 12px; margin-bottom: 24px; }
        button { background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border-color); padding: 10px 18px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.85rem; }
        button:hover { background: #1f2d42; }
        .matrix-container { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; margin-bottom: 32px; }
        .matrix-title { font-size: 1rem; margin-bottom: 16px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: center; border-bottom: 1px solid var(--border-color); font-size: 0.9rem; }
        th { color: var(--text-muted); font-weight: 500; }
        td.curr-cell { font-weight: 700; text-align: left; color: #ffffff; font-family: var(--font-mono); }
        .state-tag { padding: 6px 12px; border-radius: 4px; font-family: var(--font-mono); font-size: 0.8rem; font-weight: 700; display: inline-block; }
        .state-buy { background: var(--accent-green-bg); color: var(--accent-green); border: 1px solid var(--accent-green); }
        .state-sell { background: var(--accent-red-bg); color: var(--accent-red); border: 1px solid var(--accent-red); }
        .state-inactive { color: #4a5a70; }
        .signals-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
        .card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; }
        .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .card-title { font-size: 1.2rem; font-weight: 700; font-family: var(--font-mono); }
        .card-body p { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 6px; }
    </style>
</head>
<body>
    <header>
        <div class="title-block">
            <h1>Market Activity Scanner</h1>
            <p>Institutional Currency Displacement Matrix</p>
        </div>
        <div class="status-badge">
            <div class="indicator"></div>
            <span id="system-status">Operating Normal</span>
        </div>
    </header>
    <div class="controls-bar">
        <button onclick="fetchScanData()">Run Manual Scan</button>
        <button onclick="loadLatestScan()">Fetch Latest Scan</button>
    </div>
    <div class="matrix-container">
        <div class="matrix-title">Multi-Timeframe Currency Matrix</div>
        <table>
            <thead>
                <tr>
                    <th style="text-align: left;">Currency</th>
                    <th>1m</th><th>3m</th><th>5m</th><th>15m</th><th>1h</th><th>4h</th>
                </tr>
            </thead>
            <tbody id="matrix-body"></tbody>
        </table>
    </div>
    <h2 style="margin-bottom: 16px; font-size: 1.1rem; color: var(--text-muted);">ACTIVE DISPLACEMENT SIGNALS</h2>
    <div class="signals-grid" id="signals-container"></div>
    <script>
        const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
        const TIMEFRAMES = ['1min', '3min', '5min', '15min', '1h', '4h'];
        async function fetchScanData() {
            document.getElementById('system-status').innerText = 'Scanning...';
            try {
                const res = await fetch('/scan');
                const data = await res.json();
                renderUI(data);
                document.getElementById('system-status').innerText = 'Scan Complete';
            } catch (err) { document.getElementById('system-status').innerText = 'Error'; }
        }
        async function loadLatestScan() {
            try {
                const res = await fetch('/latest-scan');
                const data = await res.json();
                renderUI(data);
            } catch (err) { console.error(err); }
        }
        function renderUI(data) {
            const matrixBody = document.getElementById('matrix-body');
            matrixBody.innerHTML = '';
            const signalsContainer = document.getElementById('signals-container');
            signalsContainer.innerHTML = '';
            const activeMap = {};
            (data.active_currencies || []).forEach(item => {
                if (!activeMap[item.currency]) activeMap[item.currency] = {};
                activeMap[item.currency][item.timeframe] = item;
            });
            CURRENCIES.forEach(curr => {
                const tr = document.createElement('tr');
                let rowHTML = \`<td class="curr-cell">\${curr}</td>\`;
                TIMEFRAMES.forEach(tf => {
                    const signal = activeMap[curr] && activeMap[curr][tf];
                    if (signal) {
                        const classStyle = signal.bias === 'BUY' ? 'state-buy' : 'state-sell';
                        rowHTML += \`<td><span class="state-tag \${classStyle}">\${signal.bias}</span></td>\`;
                    } else {
                        rowHTML += \`<td><span class="state-tag state-inactive">—</span></td>\`;
                    }
                });
                tr.innerHTML = rowHTML;
                matrixBody.appendChild(tr);
            });
            if (!data.active_currencies || data.active_currencies.length === 0) {
                signalsContainer.innerHTML = \`<div style="color: var(--text-muted); font-size: 0.9rem;">No active institutional displacement detected currently.</div>\`;
                return;
            }
            data.active_currencies.forEach(item => {
                const card = document.createElement('div');
                card.className = 'card';
                const tagStyle = item.bias === 'BUY' ? 'state-buy' : 'state-sell';
                card.innerHTML = \`<div class="card-header"><span class="card-title">\${item.currency} (\${item.timeframe})</span><span class="state-tag \${tagStyle}">\${item.bias}</span></div><div class="card-body"><p><strong>Basket Cohesion:</strong> \${item.cohesion}</p><p><strong>Status:</strong> \${item.status}</p></div>\`;
                signalsContainer.appendChild(card);
            });
        }
        loadLatestScan();
    </script>
</body>
</html>`);
});

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

app.get('/scan', async (req, res) => {
  await executeMarketScan();
  res.json(latestScanData);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function executeMarketScan() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return;

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
          const currentRange = parseFloat(candles[0].high) - parseFloat(candles[0].low);
          const prior14 = candles.slice(1, 15);
          const avgRange = prior14.reduce((sum, c) => sum + (parseFloat(c.high) - parseFloat(c.low)), 0) / 14;

          if (currentRange >= (avgRange * 1.8)) {
            expandingPairsCount++;
            const isBullish = parseFloat(candles[0].close) >= parseFloat(candles[0].open);
            const isBase = symbol.startsWith(currency);
            const bias = isBase ? (isBullish ? 'BUY' : 'SELL') : (isBullish ? 'SELL' : 'BUY');
            if (bias === 'BUY') bullishVotes++;
            if (bias === 'SELL') bearishVotes++;
          }
        });

        const minRequired = Math.min(5, pairs.length);
        const dominantVotes = Math.max(bullishVotes, bearishVotes);
        if (expandingPairsCount >= minRequired && dominantVotes >= minRequired) {
          activeResults.push({
            currency,
            timeframe: tf,
            bias: bullishVotes > bearishVotes ? 'BUY' : 'SELL',
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
  } catch (error) {
    console.error(error);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

