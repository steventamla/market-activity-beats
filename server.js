const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const {
  executeMarketScan,
  getLatestScanData
} = require('./currency-activity-engine');
app.use(express.json());

const NTFY_TOPIC = process.env.NTFY_TOPIC || 'market-activity-tracker-889';

// PWA Manifest Route
app.get('/manifest.json', (req, res) => {
  res.json({
    name: "Market Institutions Tracker",
    short_name: "MarketTracker",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0d14",
    theme_color: "#0a0d14",
    icons: [
      {
        src: "https://ntfy.sh/static/img/icon_96x96.png",
        sizes: "96x96",
        type: "image/png"
      }
    ]
  });
});

// PWA Service Worker Route
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(() => caches.match(e.request))));
  `);
});

// Serve the Dashboard directly
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Market Institutions Tracker</title>
    <link rel="manifest" href="/manifest.json">
    <meta name="theme-color" content="#0a0d14">
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
        .controls-bar { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
        button { background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border-color); padding: 10px 18px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.85rem; }
        button:hover { background: #1f2d42; }
        .matrix-container { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 20px; margin-bottom: 32px; }
        .matrix-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .matrix-title { font-size: 1rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
        .toggle-btn { background: transparent; border: 1px solid var(--border-color); color: var(--text-muted); cursor: pointer; font-size: 1.1rem; padding: 2px 10px; border-radius: 4px; }
        .toggle-btn:hover { color: var(--text-main); background: var(--border-color); }
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
        .collapsed { display: none !important; }
    </style>
</head>
<body>
    <header>
        <div class="title-block">
            <h1>Market Institutions Tracker</h1>
            <p>Institutional Currency Displacement Matrix</p>
        </div>
        <div class="status-badge">
            <div class="indicator"></div>
            <span id="system-status">Operating Normal</span>
            <span id="last-updated" style="margin-left: 10px; color: var(--text-muted); font-size: 0.8rem;">Updated: --:--:--</span>
        </div>
    </header>
    <div class="controls-bar">
        <button onclick="fetchScanData()">Run Manual Scan</button>
        <button onclick="loadLatestScan()">Fetch Latest Scan</button>
        <button onclick="triggerTestPush()" style="border-color: var(--accent-green); color: var(--accent-green);">Test Push Alert</button>
    </div>
    <div class="matrix-container" id="matrix-box">
        <div class="matrix-header">
            <div class="matrix-title">Multi-Timeframe Currency Matrix</div>
            <button class="toggle-btn" id="matrix-toggle" onclick="toggleSection('matrix-content', this)">−</button>
        </div>
        <div id="matrix-content">
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
    </div>
    <div class="matrix-header">
        <h2 style="margin-bottom: 16px; font-size: 1.1rem; color: var(--text-muted);">ACTIVE DISPLACEMENT SIGNALS</h2>
    </div>
    <div class="signals-grid" id="signals-container"></div>

    <script>
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js')
                .then(() => console.log('PWA Service Worker Registered'))
                .catch(err => console.log('SW registration failed: ', err));
        }

        const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
        const TIMEFRAMES = ['1min', '3min', '5min', '15min', '1h', '4h'];

        function toggleSection(contentId, btn) {
            const content = document.getElementById(contentId);
            content.classList.toggle('collapsed');
            btn.innerText = content.classList.contains('collapsed') ? '+' : '−';
        }

        async function fetchScanData() {
            document.getElementById('system-status').innerText = 'Scanning...';
            try {
                const res = await fetch('/scan');
                const data = await res.json();
                renderUI(data);
                document.getElementById('system-status').innerText = 'Scan Complete';
            } catch (err) { 
                document.getElementById('system-status').innerText = 'Error'; 
            }
        }

        async function loadLatestScan() {
            try {
                const res = await fetch('/latest-scan');
                const data = await res.json();
                renderUI(data);
            } catch (err) { 
                console.error(err); 
            }
        }

        async function triggerTestPush() {
            document.getElementById('system-status').innerText = 'Sending Push...';
            try {
                await fetch('/test-push');
                document.getElementById('system-status').innerText = 'Test Push Sent';
            } catch (err) {
                document.getElementById('system-status').innerText = 'Push Error';
            }
        }

        function updateLastUpdatedTime(timestamp) {
            const timeEl = document.getElementById('last-updated');
            if (!timestamp) {
                timeEl.innerText = 'Updated: Never';
                return;
            }
            const date = new Date(timestamp);
            timeEl.innerText = \`Updated: \${date.toLocaleTimeString()}\`;
        }

        function renderUI(data) {
            updateLastUpdatedTime(data.scan_timestamp);
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
        setInterval(loadLatestScan, 120000);
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
  res.json(getLatestScanData());
});

app.get('/scan', async (req, res) => {
  const result = await executeMarketScan();
  res.json(result);
});

app.get('/test-push', async (req, res) => {
  await sendPushNotification([{
    currency: 'TEST',
    timeframe: '1m',
    bias: 'BUY',
    cohesion: 'Dashboard UI Test Alert'
  }]);
  res.json({ status: 'success' });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendPushNotification(signals) {
  if (!signals || signals.length === 0) return;

  const signalSummary = signals.map(s => `${s.currency} (${s.timeframe}): ${s.bias} [${s.cohesion}]`).join('\n');
  
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      body: `Institutional Displacement Detected:\n\n${signalSummary}`,
      headers: {
        'Title': `Market Tracker Alert (${signals.length} Active)`,
        'Priority': 'high',
        'Tags': 'chart_with_upwards_trend,warning'
      }
    });
    console.log('Push notification sent successfully.');
  } catch (err) {
    console.error('Failed to send push notification:', err);
  }
}



app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
