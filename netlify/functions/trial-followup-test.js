const nodemailer = require('nodemailer');
const { identity } = require('../../club.config');
const { validatePin } = require('./_coach-auth');
const { validateDevPin } = require('./auth-dev-pin');
const { getTermConfig } = require('./_term-config');
const { createPaymentLink, emailHtml } = require('./_trial-followup-lib');

// Manual test send for the trial follow-up email — fires one real email
// (with a real Square payment link, fake sample child/parent) to a chosen
// address, without touching real register/index data. Kept as its own
// plain (non-scheduled) function because Netlify blocks direct HTTP
// invocation of functions declared with a `schedule` in netlify.toml.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authPin = event.headers['x-coach-pin'];
  const devPin = event.headers['x-dev-pin'];
  if (!validatePin(authPin) && !validateDevPin(devPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const termConfig = await getTermConfig();
  const CLASS_INFO = termConfig.classes;
  const termName = termConfig.termName;
  const targetClass = CLASS_INFO.find(c => c.match === 'Minis') || CLASS_INFO.find(c => c.pence > 0);
  if (!targetClass) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No payable class configured to test with' }) };
  }
  const totalStr = `£${(targetClass.pence / 100).toFixed(2)}`;
  const destination = body.toEmail || process.env.GMAIL_USER;

  let paymentUrl;
  try {
    paymentUrl = await createPaymentLink({
      targetClass, termName, childName: 'Test Child',
      idempotencyKey: `cgy-trial-followup-test-${Date.now()}`,
      referenceId: `trial-followup-test:${Date.now()}`,
    });
  } catch (err) {
    console.error('trial-followup-test: Square error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Square error: ' + err.message }) };
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
      to: destination,
      subject: `[TEST] Test Child, ready to join us properly? 🤸 — ${identity.name}`,
      html: emailHtml({ parentName: 'Test Parent', childName: 'Test Child', targetClass, termName, totalStr, paymentUrl }),
    });
  } catch (err) {
    console.error('trial-followup-test: email error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Email error: ' + err.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, sentTo: destination }) };
};
