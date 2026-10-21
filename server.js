
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

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_HISTORY_ITEMS = 500;

let previousActiveSignals = new Set();
let scheduledScanRunning = false;

const activityHistory = [];

app.get('/manifest.json', (req, res) => res.json({
  name: 'Market Activity Monitor',
  short_name: 'MarketMonitor',
  start_url: '/',
  display: 'standalone',
  background_color: '#101722',
  theme_color: '#101722',
  icons: [{
    src: 'https://ntfy.sh/static/img/icon_96x96.png',
    sizes: '96x96',
    type: 'image/png'
  }]
}));

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', e => {
      e.respondWith(fetch(e.request));
    });
  `);
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/latest-scan', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(getLatestScanData());
});

app.get('/activity-history', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: activityHistory });
});

function signalKey(signal) {
  return `${signal.currency}|${signal.timeframe}`;
}

function timeAgo(value) {
  if (!value) return 'Time unknown';

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Time unknown';

  const minutes = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 60000)
  );

  if (minutes < 1) return 'Just now';

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function recordActivity(signals, source = 'scan') {
  const detectedAt = new Date().toISOString();

  for (const signal of signals || []) {
    activityHistory.unshift({
      currency: signal.currency,
      timeframe: signal.timeframe,
      last_active_at: signal.last_active_at || null,
      detected_at: detectedAt,
      source
    });
  }

  if (activityHistory.length > MAX_HISTORY_ITEMS) {
    activityHistory.length = MAX_HISTORY_ITEMS;
  }
}

async function sendPushNotification(
  signals,
  titlePrefix = 'Market Activity Detected'
) {
  if (!Array.isArray(signals) || signals.length === 0) return true;

  const summary = signals.map(signal =>
    `Currency: ${signal.currency}\n` +
    `Timeframe: ${signal.timeframe}\n` +
    `Time ago: ${timeAgo(signal.last_active_at)}\n` +
    `Classification: ${signal.agreement || 'early'}\n` +
    `Currency bias: ${signal.direction || 'unknown'}\n` +
    `Pairs supporting: ${signal.supporting_pairs ?? 0}; opposing: ${signal.opposing_pairs ?? 0}\n` +
    `Pairs: ${(signal.pairs || []).map(pair => pair.symbol + ' (' + pair.currency_vote + ')').join(', ') || 'none'}`
  ).join('\n\n');

  try {
    const response = await fetch(
      `https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`,
      {
        method: 'POST',
        body: summary,
        headers: {
          Title: titlePrefix,
          Priority: 'default',
          Tags: 'chart'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Notification failed: HTTP ${response.status}`);
    }

    console.log(
      `Push notification sent for ${signals.length} new signal(s).`
    );

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

  const currentActiveSignals = new Set(
    activeSignals.map(signalKey)
  );

  // Only notify for a currency/timeframe absent from the previous
  // successful scan's active set.
  const newSignals = activeSignals.filter(
    signal => !previousActiveSignals.has(signalKey(signal))
  );

  if (newSignals.length > 0) {
    const sent = await sendPushNotification(newSignals);

    // If delivery fails, leave the previous set unchanged so the
    // next scan can retry the notification.
    if (!sent) return result;

    recordActivity(newSignals, 'scan');
  }

  previousActiveSignals = currentActiveSignals;

  return result;
}

// This endpoint intentionally starts a scan and may use API credits.
app.get('/scan', async (req, res) => {
  try {
    const result = await runScanAndNotify();

    res.status(result.scan_status === 'error' ? 502 : result.scan_status === 'scanning' ? 409 : 200)
      .json(result);
  } catch (error) {
    console.error('Manual scan failed:', error);

    res.status(500).json({
      scan_status: 'error',
      error: error.message
    });
  }
});

// Sends saved active signals only. It does not start a scan or alter
// the notification deduplication baseline.
app.get('/test-real-signal', async (req, res) => {
  const result = getLatestScanData();

  const signals =
    result?.scan_status === 'success'
      ? (result.active_currencies || [])
      : [];

  if (!signals.length) {
    return res.status(409).json({
      status: 'no_saved_active_signal',
      message: 'No active signal is saved in this server process. This endpoint does not start a scan.'
    });
  }

  const sent = await sendPushNotification(
    signals,
    'Saved-Signal Test'
  );

  return res.status(sent ? 200 : 502).json({
    status: sent ? 'success' : 'error',
    signals_tested: signals.length,
    scan_started: false,
    duplicate_baseline_changed: false
  });
});

app.get('/test-push', async (req, res) => {
  const sent = await sendPushNotification([{
    currency: 'TEST',
    timeframe: '15m',
    last_active_at: new Date().toISOString()
  }], 'Test Notification');

  res.status(sent ? 200 : 502).json({
    status: sent ? 'success' : 'error',
    scan_started: false
  });
});

async function scheduledScan() {
  if (scheduledScanRunning) {
    console.log(
      '[SCHEDULE] Scan skipped because another scheduled scan is still running.'
    );
    return;
  }

  scheduledScanRunning = true;

  console.log(
    `[SCHEDULE] Scan started at ${new Date().toISOString()}`
  );

  try {
    const result = await runScanAndNotify();

    console.log(
      `[SCHEDULE] Scan finished at ${new Date().toISOString()} | ` +
      `status=${result.scan_status} | ` +
      `active_signals=${result.active_signals_count ?? 0}`
    );
  } catch (error) {
    console.error('[SCHEDULE] Scan error:', error);
  } finally {
    scheduledScanRunning = false;

    console.log(
      '[SCHEDULE] Next scan scheduled in 5 minutes. ' +
      'One scan analyses all four timeframes.'
    );

    setTimeout(scheduledScan, SCAN_INTERVAL_MS);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setTimeout(scheduledScan, 5000);
});
