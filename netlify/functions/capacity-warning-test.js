const nodemailer = require('nodemailer');
const { identity } = require('../../club.config');
const { validatePin } = require('./_coach-auth');
const { validateDevPin } = require('./auth-dev-pin');
const { getTermConfig } = require('./_term-config');
const { createPaymentLink, emailHtml } = require('./_capacity-warning-lib');

// Manual test send for the "class nearly full" warning email — fires one
// real email (with a real Square payment link, fake sample child/parent)
// to a chosen address, without touching real registration/override data.
// Kept as its own plain (non-scheduled) function because Netlify blocks
// direct HTTP invocation of functions declared with a `schedule` in netlify.toml.
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

  const siteUrl = process.env.SITE_URL || 'https://www.championgymnastics.co.uk';
  const termConfig = await getTermConfig();
  const classInfo = termConfig.classes.find(c => c.match === 'Minis') || termConfig.classes.find(c => !c.trial && c.pence > 0);
  if (!classInfo) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No payable class configured to test with' }) };
  }
  const priceStr = classInfo.pence ? `£${(classInfo.pence / 100).toFixed(2)}` : '';
  const destination = body.toEmail || process.env.GMAIL_USER;

  let paymentUrl;
  try {
    paymentUrl = await createPaymentLink({
      classInfo, termName: termConfig.termName, childName: 'Test Child',
      submissionId: `capacity-warning-test-${Date.now()}`, siteUrl,
    });
  } catch (err) {
    console.error('capacity-warning-test: Square error:', err.message);
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
      subject: `[TEST] ${classInfo.label} is filling up — please pay soon to secure Test Child's place`,
      html: emailHtml({ parentName: 'Test Parent', childName: 'Test Child', classInfo, priceStr, paymentUrl, siteUrl }),
    });
  } catch (err) {
    console.error('capacity-warning-test: email error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Email error: ' + err.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, sentTo: destination }) };
};
