const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const { executeMarketScan, getLatestScanData } = require('./currency-activity-engine.js');

app.use(express.json());
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'market-activity-tracker-889';
const HOUR_MS = 60 * 60 * 1000;
let previousActiveKeys = new Set();
let scheduledScanRunning = false;
const activityHistory = [];
const MAX_HISTORY_ITEMS = 500;

app.get('/manifest.json', (req, res) => res.json({
  name: 'Market Activity Monitor', short_name: 'MarketMonitor', start_url: '/', display: 'standalone',
  background_color: '#101722', theme_color: '#101722',
  icons: [{ src: 'https://ntfy.sh/static/img/icon_96x96.png', sizes: '96x96', type: 'image/png' }]
}));

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`self.addEventListener('install', e => e.waitUntil(self.skipWaiting())); self.addEventListener('activate', e => e.waitUntil(self.clients.claim())); self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });`);
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/latest-scan', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(getLatestScanData());
});
app.get('/activity-history', (req, res) => res.json({ items: activityHistory }));

function signalKey(signal) {
  // Activity identity deliberately excludes direction: this is an activity monitor.
  return `${signal.currency}|${signal.timeframe}`;
}

function timeAgo(value) {
  if (!value) return 'Time unknown';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Time unknown';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
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
  if (activityHistory.length > MAX_HISTORY_ITEMS) activityHistory.length = MAX_HISTORY_ITEMS;
}

async function sendPushNotification(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return true;
  const summary = signals.map(signal =>
    `Currency: ${signal.currency}\nTimeframe: ${signal.timeframe}\nLast active: ${timeAgo(signal.last_active_at)}`
  ).join('\n\n');

  try {
    const response = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      body: `Market activity detected\n\n${summary}`,
      headers: {
        Title: `Market Activity Detected (${signals.length})`,
        Priority: 'high',
        Tags: 'chart_with_upwards_trend'
      }
    });
    if (!response.ok) throw new Error(`Notification failed: HTTP ${response.status}`);
    console.log(`Push notification sent for ${signals.length} new activity signal(s).`);
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
  const newSignals = activeSignals.filter(signal => !previousActiveKeys.has(signalKey(signal)));

  // The first successful scan also alerts on any activity it detects.
  if (newSignals.length) {
    recordActivity(newSignals, 'scan');
    const sent = await sendPushNotification(newSignals);
    // Keep the previous baseline if delivery fails so the next scan can retry.
    if (!sent) return result;
  }
  previousActiveKeys = currentKeys;
  return result;
}

app.get('/scan', async (req, res) => {
  try {
    const result = await runScanAndNotify();
    res.status(result.scan_status === 'error' ? 502 : 200).json(result);
  } catch (error) {
    console.error('Manual scan failed:', error);
    res.status(500).json({ scan_status: 'error', error: error.message });
  }
});

// Tests a push using existing in-memory scan results; it never starts a new scan.
app.get('/test-real-signal', async (req, res) => {
  const result = getLatestScanData();
  const signals = result?.scan_status === 'success' ? (result.active_currencies || []) : [];
  if (!signals.length) {
    return res.status(409).json({ status: 'no_saved_active_signal', message: 'No active signal is currently saved in this server process. This endpoint does not run a scan.' });
  }
  const sent = await sendPushNotification(signals);
  if (sent) recordActivity(signals, 'test');
  return res.status(sent ? 200 : 502).json({ status: sent ? 'success' : 'error', signals_tested: signals.length, scan_started: false });
});

app.get('/test-push', async (req, res) => {
  const sent = await sendPushNotification([{ currency: 'TEST', timeframe: '15m', last_active_at: new Date().toISOString() }]);
  res.status(sent ? 200 : 502).json({ status: sent ? 'success' : 'error' });
});

async function scheduledScan() {
  if (scheduledScanRunning) return;
  scheduledScanRunning = true;
  console.log(`[SCHEDULE] Scan started at ${new Date().toISOString()}`);
  try {
    const result = await runScanAndNotify();
    console.log(`[SCHEDULE] Scan finished at ${new Date().toISOString()} | status=${result.scan_status} | active_signals=${result.active_signals_count ?? 0}`);
  } catch (error) {
    console.error('[SCHEDULE] Scan error:', error);
  } finally {
    scheduledScanRunning = false;
    console.log('[SCHEDULE] Next scan scheduled in 60 minutes. The scheduler uses one hourly scan for all four timeframes.');
    setTimeout(scheduledScan, HOUR_MS);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setTimeout(scheduledScan, 5000);
});
