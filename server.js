const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const {
  executeMarketScan,
  getLatestScanData
} = require('./currency-activity-engine.js');
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


 // Serve the maintained dashboard file.
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
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
    const response = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      body: `Institutional Displacement Detected:\n\n${signalSummary}`,
      headers: {
        'Title': `Market Tracker Alert (${signals.length} Active)`,
        'Priority': 'high',
        'Tags': 'chart_with_upwards_trend,warning'
      }
    });
   if (!response.ok) {
  throw new Error(`Notification failed: ${response.status}`);
}
    console.log('Push notification sent successfully.');
  } catch (err) {
    console.error('Failed to send push notification:', err);
  }
}



app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
