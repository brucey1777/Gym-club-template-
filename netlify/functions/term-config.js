const { validatePin } = require('./_coach-auth');
const { getTermConfig } = require('./_term-config');

// Read-only: term dates and class prices are edited directly in
// _term-config.js's DEFAULT_CONFIG (a code change, deployed like any
// other) rather than through a staff-facing Term Wizard UI, which has been
// removed — along with the POST handler this function used to expose for
// it. Kept as a GET-only endpoint since other staff pages still fetch the
// current class list from here (e.g. to build a registration's class
// checkboxes).
exports.handler = async (event) => {
  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  if (event.httpMethod === 'GET') {
    const config = await getTermConfig();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, isDefault: true }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
