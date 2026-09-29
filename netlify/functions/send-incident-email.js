const nodemailer = require('nodemailer');
const { identity, contact } = require('../../club.config');
const { validatePin } = require('./_coach-auth');
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { key } = body;
  if (!key) return { statusCode: 400, body: JSON.stringify({ error: 'Missing incident key' }) };

  const store = getStore({
    name: 'incidents',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });

  const inc = await store.get(key, { type: 'json' }).catch(() => null);
  if (!inc) return { statusCode: 404, body: JSON.stringify({ error: 'Incident not found' }) };

  if (!inc.parentEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No parent email on record for this incident' }) };
  }

  const sevLabel = { low: 'Low', medium: 'Medium', high: 'High' }[inc.severity] || inc.severity;
  const sevColour = { low: '#27AE60', medium: '#F5A623', high: '#E74C3C' }[inc.severity] || '#666';

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:500px;margin:0 auto;color:#1A2B5E">
    <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
      <img src="${process.env.SITE_URL}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto;width:160px;height:auto"/>
    </div>
    <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
      <p>Dear ${inc.parentName || 'Parent/Guardian'},</p>
      <p>We are writing to inform you of an incident involving <strong>${inc.childName}</strong> during their gymnastics session. We take the safety and wellbeing of all children in our care very seriously.</p>

      <div style="background:#fff;border:2px solid #E8E0F0;border-radius:12px;padding:16px 18px;margin:18px 0">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="padding:5px 0;font-weight:800;width:40%">Child:</td><td>${inc.childName}</td></tr>
          <tr><td style="padding:5px 0;font-weight:800">Class:</td><td>${inc.className}</td></tr>
          <tr><td style="padding:5px 0;font-weight:800">Date:</td><td>${inc.date}</td></tr>
          <tr><td style="padding:5px 0;font-weight:800">Severity:</td><td><span style="background:${sevColour}22;color:${sevColour};border-radius:50px;padding:2px 10px;font-weight:700;text-transform:uppercase;font-size:12px">${sevLabel}</span></td></tr>
          <tr><td style="padding:5px 0;font-weight:800">Reported by:</td><td>${inc.reportedBy || '—'}</td></tr>
        </table>
      </div>

      <div style="background:#FFF8E8;border:2px solid #F5A623;border-radius:12px;padding:14px 18px;margin:18px 0">
        <div style="font-weight:800;font-size:0.9rem;margin-bottom:6px">Incident Description</div>
        <p style="margin:0;font-size:13px;line-height:1.6">${inc.description}</p>
      </div>

      ${inc.emergencyName ? `<p style="font-size:13px">Emergency contact on file: <strong>${inc.emergencyName}</strong>${inc.emergencyPhone ? ` · ${inc.emergencyPhone}` : ''}</p>` : ''}

      <p>If you have any questions or concerns, please do not hesitate to contact us at <a href="mailto:${contact.email}" style="color:#1A2B5E">${contact.email}</a>.</p>
      <p style="margin-top:24px">${identity.name} 🤸</p>
    </div>
  </div>`;

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
      to: inc.parentEmail,
      subject: `Incident report — ${inc.childName} · ${inc.date} — ${identity.name}`,
      html,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('send-incident-email error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Email failed: ' + err.message }) };
  }
};
