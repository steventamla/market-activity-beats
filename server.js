
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

const {
  executeMarketScan,
  getLatestScanData
} = require('./currency-activity-engine.js');


const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';
const SCAN_TOKEN = process.env.SCAN_TOKEN || '';

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_HISTORY_ITEMS = 500;

let previousActiveSignals = new Set();
const recordedHistoryKeys = new Set();
let scheduledScanRunning = false;
let scanAndNotifyRunning = false;

const activityHistory = [];

app.get('/manifest.json', (req, res) => res.json({
  name: 'Market Activity Finder',
  short_name: 'MarketFinder',
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
  res.json({ items: activityHistory.slice(0, 50), total: activityHistory.length });
});

function signalKey(signal) {
  // Treat each qualifying completed candle as a distinct impulse event.
  // This prevents repeated alerts for the same candle while allowing a
  // later, genuinely new impulse in the same currency/timeframe to alert.
  const impulseCandles = (signal.pairs || [])
    .map(pair => `${pair.symbol}:${pair.impulse_start_at || pair.candle_time || ''}:${pair.pair_direction || ''}`)
    .sort()
    .join('|');

  return `${signal.currency}|${signal.timeframe}|${impulseCandles}`;
}

function activityTime(value) {
  if (!value) return 'Unknown';

  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return 'Unknown';

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Dar_es_Salaam',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(timestamp);
}

function recordActivity(signals, source = 'scan') {
  const detectedAt = new Date().toISOString();

  for (const signal of signals || []) {
    const key = signalKey(signal);
    if (recordedHistoryKeys.has(key)) continue;
    recordedHistoryKeys.add(key);
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

async function sendPushNotification(signals, titlePrefix = 'Market Activity Finder') {
  if (!Array.isArray(signals) || signals.length === 0) return true;
  if (!NTFY_TOPIC) {
    console.error('Push notification skipped: NTFY_TOPIC is not configured.');
    return false;
  }

  // Notifications intentionally contain only the three requested fields.
  // Keep batches small so ntfy displays plain text instead of attachments.
  const MAX_MESSAGE_CHARS = 3000;
  const formatSignal = signal =>
    `Timeframe: ${signal.timeframe}\n` +
    `Time: ${activityTime(signal.last_active_at)}\n` +
    `Currency: ${signal.currency}`;

  const batches = [];
  let batch = '';

  for (const signal of signals) {
    const block = formatSignal(signal);
    const candidate = batch ? batch + '\n\n' + block : block;

    if (candidate.length > MAX_MESSAGE_CHARS && batch) {
      batches.push(batch);
      batch = block;
    } else {
      batch = candidate;
    }
  }

  if (batch) batches.push(batch);

  try {
    for (let i = 0; i < batches.length; i++) {
      const title = batches.length > 1
        ? `${titlePrefix} (${i + 1}/${batches.length})`
        : titlePrefix;

      const response = await fetch(
        `https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`,
        {
          method: 'POST',
          body: batches[i],
          headers: {
            Title: title,
            ...(NTFY_TOKEN ? { Authorization: `Bearer ${NTFY_TOKEN}` } : {}),
            Priority: 'default',
            Tags: 'chart',
            'Content-Type': 'text/plain; charset=utf-8'
          }
        }
      );

      if (!response.ok) throw new Error(`Notification failed: HTTP ${response.status}`);
    }

    console.log(`Market Activity Finder sent ${signals.length} activity item(s) in ${batches.length} message(s).`);
    return true;
  } catch (error) {
    console.error('Push notification failed:', error.message);
    return false;
  }
}

async function runScanAndNotify() {
  // One shared lock covers scheduled and manual requests. Never start a
  // second scan while the Twelve Data request sequence is still running.
  if (scanAndNotifyRunning) {
    return { ...getLatestScanData(), scan_status: 'scanning' };
  }

  scanAndNotifyRunning = true;

  try {
    const result = await executeMarketScan();

    if (result.scan_status !== 'success') {
      console.error('Scan failed:', result.error || result.scan_status);
      return result;
    }

    const activeSignals = result.active_currencies || [];

    const currentActiveSignals = new Set(
      activeSignals.map(signalKey)
    );

    // Notify once for each new qualifying impulse event.
    const newSignals = activeSignals.filter(
      signal => !previousActiveSignals.has(signalKey(signal))
    );

    if (newSignals.length > 0) {
      // Record the event independently of push delivery. History keys prevent
      // duplicate history rows if ntfy fails and delivery is retried next scan.
      recordActivity(newSignals, 'scan');
      const sent = await sendPushNotification(newSignals);

      // If delivery fails, leave the previous set unchanged so the
      // next scan can retry the notification.
      if (!sent) return result;
    }

    previousActiveSignals = currentActiveSignals;

    return result;
  } finally {
    scanAndNotifyRunning = false;
  }
}

// Protect endpoints that can trigger scans or send notifications.
function requireScanToken(req, res, next) {
  const token = req.get('x-scan-token');
  if (!SCAN_TOKEN || token !== SCAN_TOKEN) {
    return res.status(401).json({
      status: 'unauthorized',
      message: 'Valid scan token required.'
    });
  }
  next();
}

app.get('/scan', requireScanToken, async (req, res) => {

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
app.get('/test-real-signal', requireScanToken, async (req, res) => {
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

app.get('/test-push', requireScanToken, async (req, res) => {
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
      'One scan analyses all five timeframes.'
    );

    setTimeout(scheduledScan, SCAN_INTERVAL_MS);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setTimeout(scheduledScan, 5000);
});
