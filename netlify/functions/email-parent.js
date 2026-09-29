const nodemailer = require('nodemailer');
const { identity, contact } = require('../../club.config');
const { validatePin } = require('./_coach-auth');

// One-off custom email to a single registration's parent, sent from the
// Register tab's action menu — for anything a template email (payment
// link, capacity warning, broadcast) doesn't cover, e.g. a one-to-one
// question or a heads-up specific to that family.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { submissionId, subject, message } = body;
  if (!submissionId) return { statusCode: 400, body: 'Missing submissionId' };
  if (!subject || !subject.trim()) return { statusCode: 400, body: 'Missing subject' };
  if (!message || !message.trim()) return { statusCode: 400, body: 'Missing message' };

  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID;
  if (!token || !siteId) return { statusCode: 500, body: 'Missing env vars' };

  let data;
  try {
    const res = await fetch(
      `https://api.netlify.com/api/v1/submissions/${submissionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Netlify API ${res.status}`);
    const sub = await res.json();
    data = sub.data || {};
  } catch (err) {
    console.error('email-parent: fetch submission error:', err.message);
    return { statusCode: 500, body: 'Could not fetch submission' };
  }

  if (!data.email) {
    return { statusCode: 400, body: 'This registration has no email address' };
  }

  // Escape then convert line breaks to <br> so plain-text paragraphs in the
  // textarea keep their line breaks without letting the sender inject markup.
  const bodyHtml = String(message)
    .replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
    .split(/\n{2,}/)
    .map(para => `<p style="margin:0 0 14px">${para.replace(/\n/g, '<br>')}</p>`)
    .join('');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1A2B5E">
    <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
      <img src="${process.env.SITE_URL || 'https://www.championgymnastics.co.uk'}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto 4px;width:160px;height:auto" />
    </div>
    <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
      ${bodyHtml}
      <p style="font-size:13px;color:#7A7A8A;margin-top:24px">If you have any questions, just reply to this email or contact us at <a href="mailto:${contact.email}" style="color:#1A2B5E">${contact.email}</a>.</p>
      <p style="margin-top:8px">${identity.name} 🤸</p>
    </div>
  </div>`;

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
      to: data.email,
      bcc: process.env.GMAIL_USER,
      subject: subject.trim(),
      html,
    });
  } catch (err) {
    console.error('email-parent: send error:', err.message);
    return { statusCode: 500, body: 'Failed to send email' };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, email: data.email }) };
};
