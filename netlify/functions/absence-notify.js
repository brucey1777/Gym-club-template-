const { getStore } = require('@netlify/blobs');
const nodemailer = require('nodemailer');
const { identity } = require('../../club.config');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;

  // Rate limit
  const rlStore = getStore({ name: 'rate-limits', siteID: siteId, token });
  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';
  const key = `absence:${ip}`;
  try {
    const existing = await rlStore.get(key, { type: 'json' }).catch(() => null);
    const now = Date.now();
    if (existing && existing.count >= 5 && (now - existing.first) < 3600000) {
      return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests' }) };
    }
    await rlStore.setJSON(key, { count: (existing?.count || 0) + 1, first: existing?.first || now });
  } catch (err) {
    console.error('Rate limit check failed:', err.message);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { childName, parentName, email, className, sessionDate, notes } = body;
  if (!childName || !parentName || !email || !className || !sessionDate) {
    return { statusCode: 400, body: JSON.stringify({ error: 'childName, parentName, email, className, sessionDate are required' }) };
  }

  try {
    const absenceStore = getStore({ name: 'absences', siteID: siteId, token });
    const blobKey = `${sessionDate}_${Date.now()}`;
    await absenceStore.setJSON(blobKey, {
      childName,
      parentName,
      email,
      className,
      sessionDate,
      notes: notes || '',
      submittedAt: new Date().toISOString(),
    });

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });

    await transporter.sendMail({
      from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      subject: `Absence notification – ${childName} (${sessionDate})`,
      html: `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;color:#333;padding:24px;">
  <h2 style="color:#0d1b2a;">Absence Notification</h2>
  <table style="border-collapse:collapse;width:100%;max-width:500px;">
    <tr><td style="padding:8px;font-weight:bold;width:140px;">Child:</td><td style="padding:8px;">${childName}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Parent:</td><td style="padding:8px;">${parentName}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Parent email:</td><td style="padding:8px;">${email}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Class:</td><td style="padding:8px;">${className}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Session date:</td><td style="padding:8px;">${sessionDate}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Notes:</td><td style="padding:8px;">${notes || '—'}</td></tr>
  </table>
</body></html>`,
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('absence-notify error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
