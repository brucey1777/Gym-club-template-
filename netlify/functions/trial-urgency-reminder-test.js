const nodemailer = require('nodemailer');
const { identity } = require('../../club.config');
const { validatePin } = require('./_coach-auth');
const { validateDevPin } = require('./auth-dev-pin');

// Manual test send for the trial urgency reminder email — fires one real
// email (fake sample child/parent) to a chosen address, without touching
// real register/trial-followups data. Kept as its own plain (non-scheduled)
// function because Netlify blocks direct HTTP invocation of functions
// declared with a `schedule` in netlify.toml.
function emailHtml({ parentName, childName, siteUrl }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1A2B5E">
    <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
      <img src="${siteUrl}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto 4px;width:160px;height:auto" />
    </div>
    <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
      <p>Hi ${parentName || 'there'},</p>
      <p>We loved having <strong>${childName || 'your child'}</strong> try a session with us! Spaces are filling up fast for this term, and we'd hate for ${childName || 'them'} to miss out on a place.</p>
      <p>You can sign up any time from our members page, no need to wait for another email from us.</p>
      <div style="text-align:center;margin:22px 0">
        <a href="${siteUrl}/members.html" style="background:#F5A623;color:#111C3E;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 30px;border-radius:50px;display:inline-block">Sign Up Now →</a>
      </div>
      <p style="font-size:13px;color:#7A7A8A;text-align:center;margin-top:-10px">${siteUrl}/members.html</p>
      <p style="margin-top:24px">See you on the mat soon! 🤸<br><strong>${identity.name}</strong></p>
    </div>
  </div>`;
}

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
  const destination = body.toEmail || process.env.GMAIL_USER;

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
      to: destination,
      subject: `[TEST] Spaces filling up fast — don't miss out, Test Child! 🤸`,
      html: emailHtml({ parentName: 'Test Parent', childName: 'Test Child', siteUrl }),
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, sentTo: destination }) };
  } catch (err) {
    console.error('trial-urgency-reminder-test: email error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Email error: ' + err.message }) };
  }
};
