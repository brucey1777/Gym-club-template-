const { validatePin } = require('./_coach-auth');
const { identity } = require('../../club.config');
const nodemailer = require('nodemailer');
const { getTermConfig } = require('./_term-config');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { classes: CLASS_INFO } = await getTermConfig();
  const { classFilter, sessionDate, reason } = body;
  if (!classFilter || !sessionDate || !reason) {
    return { statusCode: 400, body: JSON.stringify({ error: 'classFilter, sessionDate, and reason are required' }) };
  }

  const classInfo = CLASS_INFO.find(c => c.match === classFilter);
  const classLabel = classInfo ? classInfo.label : classFilter;

  try {
    const siteId = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_ACCESS_TOKEN;

    const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/forms`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const forms = await formsRes.json();
    const regForm = forms.find(f => f.name === 'registration');
    if (!regForm) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Registration form not found' }) };
    }

    const subRes = await fetch(`https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const submissions = await subRes.json();

    const targets = submissions.filter(sub => {
      const cls = sub.data && sub.data.class;
      if (!cls) return false;
      const classStr = Array.isArray(cls) ? cls.join(' ') : String(cls);
      return classStr.includes(classFilter);
    });

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });

    let sent = 0;
    let failed = 0;

    for (const sub of targets) {
      const to = sub.data.email || sub.email;
      const childName = sub.data['child-name'] || sub.data.childName || sub.data.child_name || 'your child';
      if (!to) { failed++; continue; }

      try {
        await transporter.sendMail({
          from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
          to,
          subject: `Session cancellation – ${classLabel} on ${sessionDate}`,
          html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background:#0d1b2a;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:1px;">${identity.name}</h1>
            <p style="margin:6px 0 0;color:#a0b4c8;font-size:14px;">Session cancellation notice</p>
          </td>
        </tr>
        <tr>
          <td style="background:#fffdf7;padding:32px;border-radius:0 0 8px 8px;">
            <p style="margin:0 0 16px;color:#333;font-size:15px;">Dear Parent/Guardian,</p>
            <p style="color:#333;font-size:15px;line-height:1.6;">
              We're writing to let you know that the following session has been cancelled:
            </p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f5f0e8;border-radius:6px;">
              <tr>
                <td style="padding:10px 16px;font-weight:bold;color:#0d1b2a;width:130px;">Child:</td>
                <td style="padding:10px 16px;color:#333;">${childName}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;font-weight:bold;color:#0d1b2a;">Class:</td>
                <td style="padding:10px 16px;color:#333;">${classLabel}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;font-weight:bold;color:#0d1b2a;">Date:</td>
                <td style="padding:10px 16px;color:#333;">${sessionDate}</td>
              </tr>
              <tr>
                <td style="padding:10px 16px;font-weight:bold;color:#0d1b2a;">Reason:</td>
                <td style="padding:10px 16px;color:#333;">${reason}</td>
              </tr>
            </table>
            <p style="color:#333;font-size:15px;line-height:1.6;">
              We sincerely apologise for any inconvenience this may cause. Please be assured that
              <strong>${childName}'s place in the class is fully secured</strong> and we look forward to
              seeing them at the next session.
            </p>
            <p style="color:#333;font-size:15px;line-height:1.6;">
              If you have any questions, please don't hesitate to get in touch.
            </p>
            <p style="color:#333;font-size:15px;margin-bottom:0;">
              Warm regards,<br>
              <strong>${identity.name}</strong>
            </p>
            <hr style="margin:32px 0;border:none;border-top:1px solid #e0d8c8;">
            <p style="margin:0;color:#888;font-size:12px;">
              ${identity.name} &mdash;
              <a href="mailto:${process.env.GMAIL_USER}" style="color:#0d1b2a;">${process.env.GMAIL_USER}</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
        });
        sent++;
      } catch (err) {
        console.error('Failed to send cancellation to', to, err.message);
        failed++;
      }
    }

    return { statusCode: 200, body: JSON.stringify({ sent, failed }) };
  } catch (err) {
    console.error('cancel-session error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
