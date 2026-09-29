const { getStore } = require('@netlify/blobs');
const { identity } = require('../../club.config');
const nodemailer = require('nodemailer');
const { validatePin } = require('./_coach-auth');

// Sends a staff-reviewed (possibly edited) reply to a parent enquiry, and
// marks it replied. Called from the staff.html Enquiries tab — enquiry-reply.js
// only ever drafts a reply and notifies the coach now, it never sends to the
// parent directly.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { key, replyText } = body;
  if (!key || !replyText || !replyText.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing key or replyText' }) };
  }

  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const store = getStore({ name: 'enquiries', siteID: siteId, token });

  const enquiry = await store.get(key, { type: 'json' }).catch(() => null);
  if (!enquiry) return { statusCode: 404, body: JSON.stringify({ error: 'Enquiry not found' }) };
  if (enquiry.replied) return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyReplied: true }) };

  // Convert plain text to basic HTML preserving paragraphs
  const htmlBody = replyText
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a0a2e;line-height:1.6">
      ${htmlBody}
    </div>`;

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `"Christina @ ${identity.name}" <${process.env.GMAIL_USER}>`,
      to: enquiry.email,
      replyTo: process.env.GMAIL_USER,
      subject: `Re: Your enquiry — ${identity.name}`,
      html,
    });

    await store.setJSON(key, { ...enquiry, replied: true, repliedAt: new Date().toISOString(), replyText });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('enquiry-send-reply: send error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to send email' }) };
  }
};
