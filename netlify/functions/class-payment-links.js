const { validateDevPin } = require('./auth-dev-pin');
const { getTermConfig } = require('./_term-config');
const { getClassPaymentLinks } = require('./_class-payment-links-lib');
const { requireFeature } = require('./_require-feature');

// Dev-tools view — PIN-gated, supports forcing a manual regenerate per class.
// See class-payment-links-public.js for the customer-facing equivalent.
exports.handler = async (event) => {
  const authPin = event.headers['x-dev-pin'];
  if (!validateDevPin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const blocked = requireFeature('payments');
  if (blocked) return blocked;

  try {
    const termConfig = await getTermConfig();
    const forceRegenerate = (event.queryStringParameters || {}).regenerate;
    const { links, termName } = await getClassPaymentLinks(termConfig, forceRegenerate);

    return { statusCode: 200, headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ links, termName }) };
  } catch (err) {
    console.error('class-payment-links error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error: ' + (err.message || 'unknown') }) };
  }
};
