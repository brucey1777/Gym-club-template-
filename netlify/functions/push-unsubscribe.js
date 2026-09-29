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

  const { subscription } = body;
  if (!subscription || !subscription.endpoint) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing subscription' }) };
  }

  await subsStore().delete(subKey(subscription)).catch(() => {});
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
