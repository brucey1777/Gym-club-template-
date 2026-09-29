const { getStore } = require('@netlify/blobs');
const { validatePin } = require('./_coach-auth');

// One-time migration: copies GOOGLE_SERVICE_ACCOUNT_KEY out of env vars and
// into Blobs, freeing ~2.3KB against AWS Lambda's 4KB-per-function env
// limit. Safe to leave in place afterward — it's a no-op once the env var
// is removed.
exports.handler = async (event) => {
  const pin = (event.queryStringParameters || {}).pin;
  if (!validatePin(pin)) return { statusCode: 401, body: 'Unauthorised' };

  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!key) return { statusCode: 400, body: 'GOOGLE_SERVICE_ACCOUNT_KEY env var not set — already migrated?' };

  const store = getStore({ name: 'config', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_ACCESS_TOKEN });
  await store.set('google-service-account-key', key);
  return { statusCode: 200, body: `Saved to Blobs (${key.length} chars). Now delete the GOOGLE_SERVICE_ACCOUNT_KEY env var.` };
};
