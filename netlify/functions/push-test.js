const { validatePin } = require('./_coach-auth');
const { validateDevPin } = require('./auth-dev-pin');
const { sendPushToAll } = require('./_push-lib');

// Manual test send for push notifications, triggered from the Security tab.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const authPin = event.headers['x-coach-pin'];
  const devPin = event.headers['x-dev-pin'];
  if (!validatePin(authPin) && !validateDevPin(devPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  try {
    const result = await sendPushToAll({
      title: '🔔 Test Notification',
      body: 'Push notifications are working! You\'ll get an alert like this whenever a new enquiry comes in.',
      url: '/staff.html',
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('push-test error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
