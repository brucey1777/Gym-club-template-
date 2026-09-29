const crypto = require('crypto');

function getPin() {
  return (process.env.COACH_PIN || '1234').trim();
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !pin) return false;
  try {
    const expected = getPin();
    if (pin.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { validatePin, getPin };
