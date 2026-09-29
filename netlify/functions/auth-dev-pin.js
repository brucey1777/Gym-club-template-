const crypto = require('crypto');

function getPin() { return (process.env.DEV_PIN || '0246').trim(); }

function validateDevPin(pin) {
  if (typeof pin !== 'string' || !pin) return false;
  try {
    const expected = getPin();
    if (pin.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(expected));
  } catch { return false; }
}

exports.validateDevPin = validateDevPin;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }
  if (validateDevPin(body.pin)) return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  return { statusCode: 401, body: JSON.stringify({ ok: false }) };
};
