const webpush = require('web-push');
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { contact } = require('../../club.config');

function configureWebPush() {
  webpush.setVapidDetails(
    `mailto:${contact.email}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

function subsStore() {
  return getStore({
    name: 'push-subscriptions',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}

// Stable key derived from the subscription's endpoint — unique per
// browser/device, so re-subscribing the same device overwrites its own
// record rather than creating a duplicate.
function subKey(subscription) {
  return crypto.createHash('sha256').update(subscription.endpoint).digest('hex').slice(0, 40);
}

// Sends one push to every stored subscription. Best-effort per subscription
// — a single failed/expired one doesn't stop the rest, and 404/410 (the
// subscription no longer exists on the browser's push service) triggers
// automatic cleanup so stale devices don't pile up.
async function sendPushToAll(payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.warn('push-lib: VAPID keys not configured, skipping push send');
    return { sent: 0, failed: 0, skipped: true };
  }
  configureWebPush();
  const store = subsStore();
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));

  let sent = 0, failed = 0;
  for (const blob of blobs) {
    const record = await store.get(blob.key, { type: 'json' }).catch(() => null);
    if (!record || !record.subscription) continue;
    try {
      await webpush.sendNotification(record.subscription, JSON.stringify(payload));
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 404 || err.statusCode === 410) {
        await store.delete(blob.key).catch(() => {});
      } else {
        console.error('push-lib: send error for', blob.key, err.message);
      }
    }
  }
  return { sent, failed };
}

module.exports = { subsStore, subKey, sendPushToAll };
