const { validatePin } = require('./_coach-auth');
const { validateDevPin } = require('./auth-dev-pin');
const { subsStore, subKey } = require('./_push-lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const authPin = event.headers['x-coach-pin'];
  const devPin = event.headers['x-dev-pin'];
  if (!validatePin(authPin) && !validateDevPin(devPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { subscription, label } = body;
  if (!subscription || !subscription.endpoint) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing subscription' }) };
  }

  try {
    const store = subsStore();
    await store.setJSON(subKey(subscription), {
      subscription,
      label: label || '',
      addedAt: new Date().toISOString(),
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('push-subscribe error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Could not save subscription' }) };
  }
};
