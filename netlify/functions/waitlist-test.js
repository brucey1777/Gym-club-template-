const nodemailer = require('nodemailer');
const { identity, contact } = require('../../club.config');
const { validatePin } = require('./_coach-auth');
const { validateDevPin } = require('./auth-dev-pin');

// Manual test send for the "moved to waiting list" email (fired daily by
// waitlist-unpaid.js when a class fills up on paid registrations alone).
// Sends one real email (fake sample child/parent) to a chosen address,
// without touching real registration/waiting-list data. Kept as its own
// plain (non-scheduled) function because Netlify blocks direct HTTP
// invocation of functions declared with a `schedule` in netlify.toml.
function emailHtml({ parentName, childName, classLabel, position, siteUrl }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1A2B5E">
    <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
      <img src="${siteUrl}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto;width:160px;height:auto" />
    </div>
    <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
      <p>Hi ${parentName || 'there'},</p>
      <p>We're sorry to say that <strong>${classLabel}</strong> has now filled up with families who have already paid, and we hadn't yet received payment for <strong>${childName || 'your child'}</strong>'s place.</p>
      <p>As places are only confirmed once paid, we've moved ${childName || 'your child'} onto the waiting list for this class — you're currently <strong>#${position}</strong> in the queue, and we'll be in touch the moment a space opens up.</p>
      <p>If you'd like to be considered for a different class or session instead, or have any questions, just reply to this email or contact us at <a href="mailto:${contact.email}" style="color:#1A2B5E">${contact.email}</a>.</p>
      <p>We're sorry for any disappointment and hope to welcome ${childName || 'your child'} to a class soon.</p>
      <p style="margin-top:24px">${identity.name} 🤸</p>
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
      subject: `[TEST] Test Child has been moved to the waiting list`,
      html: emailHtml({ parentName: 'Test Parent', childName: 'Test Child', classLabel: 'Minis (Fri 4–5pm)', position: 2, siteUrl }),
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, sentTo: destination }) };
  } catch (err) {
    console.error('waitlist-test: email error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Email error: ' + err.message }) };
  }
};
