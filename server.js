const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const {
  executeMarketScan,
  getLatestScanData
} = require('./currency-activity-engine.js');

app.use(express.json());

const NTFY_TOPIC =
  process.env.NTFY_TOPIC || 'market-activity-tracker-889';

const HOUR_MS = 60 * 60 * 1000;
let previousActiveKeys = null;
let scheduledScanRunning = false;

app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'Market Institutions Tracker',
    short_name: 'MarketTracker',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0d14',
    theme_color: '#0a0d14',
    icons: [{
      src: 'https://ntfy.sh/static/img/icon_96x96.png',
      sizes: '96x96',
      type: 'image/png'
    }]
  });
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', e => {
      e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    });
  `);
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/latest-scan', (req, res) => {
  res.json(getLatestScanData());
});

function signalKey(signal) {
  return `${signal.currency}|${signal.timeframe}|${signal.bias}`;
}

async function sendPushNotification(signals) {
  if (!signals || signals.length === 0) return true;

  const summary = signals
    .map(signal =>
      `${signal.currency} (${signal.timeframe}): ${signal.bias} [${signal.cohesion}]`
    )
    .join('\n');

  try {
    const response = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      body: `Market Activity Alert:\n\n${summary}`,
      headers: {
        Title: `Market Tracker Alert (${signals.length} New)`,
        Priority: 'high',
        Tags: 'chart_with_upwards_trend,warning'
      }
    });

    if (!response.ok) {
      throw new Error(`Notification failed: HTTP ${response.status}`);
    }

    console.log('Push notification sent successfully.');
    return true;
  } catch (error) {
    console.error('Push notification failed:', error.message);
    return false;
  }
}

async function runScanAndNotify() {
  const result = await executeMarketScan();

  if (result.scan_status !== 'success') {
    console.error('Scan failed:', result.error || result.scan_status);
    return result;
  }

  const activeSignals = result.active_currencies || [];
  const currentKeys = new Set(activeSignals.map(signalKey));

  // First successful scan establishes the baseline.
  if (previousActiveKeys === null) {
    previousActiveKeys = currentKeys;
    console.log('Initial scan completed; alert baseline established.');
    return result;
  }

  const newSignals = activeSignals.filter(
    signal => !previousActiveKeys.has(signalKey(signal))
  );

  if (newSignals.length > 0) {
    const sent = await sendPushNotification(newSignals);

    // Keep old keys if notification fails, so new alerts can retry.
    if (!sent) return result;
  }

  previousActiveKeys = currentKeys;
  return result;
}

app.get('/scan', async (req, res) => {
  try {
    const result = await runScanAndNotify();
    res.json(result);
  } catch (error) {
    console.error('Manual scan failed:', error);
    res.status(500).json({
      scan_status: 'error',
      error: error.message
    });
  }
});

app.get('/test-push', async (req, res) => {
  const sent = await sendPushNotification([{
    currency: 'TEST',
    timeframe: '15m',
    bias: 'BUY',
    cohesion: 'Dashboard UI Test Alert'
  }]);

  res.status(sent ? 200 : 502).json({
    status: sent ? 'success' : 'error'
  });
});

async function scheduledScan() {
  if (scheduledScanRunning) return;

  scheduledScanRunning = true;

  try {
    await runScanAndNotify();
  } catch (error) {
    console.error('Scheduled scan error:', error);
  } finally {
    scheduledScanRunning = false;
    setTimeout(scheduledScan, HOUR_MS);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setTimeout(scheduledScan, 5000);
});
