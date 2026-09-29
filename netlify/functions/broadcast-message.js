const { validatePin } = require('./_coach-auth');
const { identity, contact } = require('../../club.config');
const { validateDevPin } = require('./auth-dev-pin');
const nodemailer = require('nodemailer');
const { getTermConfig } = require('./_term-config');
const { getStore } = require('@netlify/blobs');
const { resolvePence } = require('./_registration-pricing');
const { isClassCovered, isFullyCovered } = require('./_payment-coverage-lib');

async function createPaymentLink({ classInfo, pence, termName, childName, submissionId, siteUrl }) {
  const { Client, Environment } = require('square/legacy');
  const client = new Client({
    bearerAuthCredentials: { accessToken: process.env.SQUARE_ACCESS_TOKEN },
    environment: Environment.Production,
  });
  const { result } = await client.checkoutApi.createPaymentLink({
    idempotencyKey: `cgy-broadcast-${submissionId}-${Date.now()}`,
    order: {
      locationId: process.env.SQUARE_LOCATION_ID,
      referenceId: submissionId,
      lineItems: [{
        name: `${classInfo.label} – ${termName}${childName ? ` (${childName})` : ''}`,
        quantity: '1',
        basePriceMoney: { amount: BigInt(pence ?? classInfo.pence), currency: 'GBP' },
        note: `booking:${submissionId}`,
      }],
    },
    checkoutOptions: {
      redirectUrl: `${siteUrl}/index.html?paid=1#contact`,
      askForShippingAddress: false,
      merchantSupportEmail: contact.email,
      customFields: [{ title: "Child's full name" }],
    },
  });
  return result.paymentLink.url;
}

function emailHtml(subject, message, paymentUrl, priceStr) {
  const payButton = paymentUrl ? `
            <div style="text-align:center;margin:26px 0 6px">
              <a href="${paymentUrl}" style="background:#F5A623;color:#111C3E;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 30px;border-radius:50px;display:inline-block">Pay Now${priceStr ? ` — ${priceStr}` : ''} 🔒</a>
            </div>
            <p style="font-size:12px;color:#999;text-align:center;margin:4px 0 0">Secure payment via Square, linked to your registration.</p>` : '';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background:#0d1b2a;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">
            <img src="${process.env.SITE_URL || 'https://www.championgymnastics.co.uk'}/logo.png" alt="${identity.name}" width="120" style="display:block;margin:0 auto 12px;width:120px;height:auto">
            <h1 style="margin:0;color:#fff;font-size:22px;letter-spacing:1px;">${identity.name}</h1>
            <p style="margin:6px 0 0;color:#a0b4c8;font-size:14px;">Message from your coaches</p>
          </td>
        </tr>
        <tr>
          <td style="background:#fffdf7;padding:32px;border-radius:0 0 8px 8px;">
            <h2 style="margin:0 0 16px;color:#0d1b2a;font-size:18px;">${subject}</h2>
            <div style="color:#333;font-size:15px;line-height:1.6;white-space:pre-wrap;">${message}</div>
            ${payButton}
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
</html>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authPin = event.headers['x-coach-pin'];
  const isTest = (() => { try { return JSON.parse(event.body || '{}').classFilter === '__test__'; } catch { return false; } })();
  if (!validatePin(authPin) && !(isTest && validateDevPin(authPin))) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const termConfig = await getTermConfig();
  const { classes: CLASS_INFO } = termConfig;
  const siteUrl = process.env.SITE_URL || 'https://www.championgymnastics.co.uk';
  const { classFilter, subject, message, includePaymentButton } = body;
  if (!subject || !message) {
    return { statusCode: 400, body: JSON.stringify({ error: 'subject and message are required' }) };
  }

  // Test mode — send only to club inbox, no parents
  if (classFilter === '__test__') {
    try {
      let paymentUrl = null, priceStr = '';
      if (includePaymentButton) {
        const classInfo = CLASS_INFO.find(c => c.match === 'Minis') || CLASS_INFO.find(c => !c.trial && c.pence > 0);
        if (classInfo) {
          priceStr = classInfo.pence ? `£${(classInfo.pence / 100).toFixed(2)}` : '';
          try {
            paymentUrl = await createPaymentLink({
              classInfo, termName: termConfig.termName, childName: 'Test Child',
              submissionId: `broadcast-test-${Date.now()}`, siteUrl,
            });
          } catch (err) {
            console.warn('Test send: Square link failed', err.message);
          }
        }
      }
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      });
      await transporter.sendMail({
        from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
        to: contact.adminEmail,
        subject,
        html: emailHtml(subject, message, paymentUrl, priceStr),
      });
      return { statusCode: 200, body: JSON.stringify({ sent: 0, failed: 0, test: true }) };
    } catch (err) {
      console.error('Test send failed', err.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Test send failed: ' + err.message }) };
    }
  }

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

    // Apply overrides before any class matching, so a converted/edited
    // registration (e.g. trial -> ongoing class) is chased for its current
    // class, not its original one.
    const settingsStore = getStore({ name: 'settings', siteID: siteId, token });
    const overrides = await settingsStore.get('registration-overrides', { type: 'json' }).catch(() => ({})) || {};
    submissions.forEach(s => { if (overrides[s.id]) Object.assign(s.data, overrides[s.id]); });

    const nonTrialMatches = CLASS_INFO.filter(c => !c.trial).map(c => c.match);
    const targetClassInfo = classFilter && classFilter !== 'all' ? CLASS_INFO.find(c => c.match === classFilter) : null;

    let targets = submissions.filter(sub => {
      // A coach hiding a registration (staff.html's "Move to hidden") means
      // stop contacting them — broadcasts (including "Chase Unpaid") must
      // honour that the same as the automated reminder/capacity/waitlist
      // emails do.
      if (overrides[sub.id] && overrides[sub.id]._manuallyHidden) return false;

      const cls = sub.data && sub.data.class;
      if (!cls) return false;
      const classStr = Array.isArray(cls) ? cls.join(' ') : String(cls);

      if (!classFilter || classFilter === 'all') {
        return nonTrialMatches.some(m => classStr.includes(m));
      }
      return classStr.includes(classFilter);
    });

    // With a payment button attached, only send to families who still owe
    // for the class(es) being chased — paying families would just get a
    // confusing "pay now" they don't need. A submission only has one
    // payment total, so "has any payment record" isn't enough to know
    // *this* class is covered for a family enrolled in more than one —
    // isClassCovered/isFullyCovered checks the actual amount paid against
    // what this specific class (or, for an "all classes" chase, everything
    // they're enrolled in) actually costs.
    let paidAmounts = {};
    if (includePaymentButton) {
      const payStore = getStore({ name: 'payments', siteID: siteId, token });
      try {
        const { blobs } = await payStore.list({ prefix: 'submission:' });
        const records = await Promise.all(blobs.map(b => payStore.get(b.key, { type: 'json' }).catch(() => null)));
        blobs.forEach((b, i) => {
          if (records[i]) paidAmounts[b.key.replace('submission:', '')] = records[i].amountPence || 0;
        });
      } catch (err) {
        console.error('broadcast-message: could not read payments, aborting to avoid emailing already-paid families:', err.message);
        return { statusCode: 503, body: JSON.stringify({ error: 'Payment verification unavailable' }) };
      }
      targets = targets.filter(sub => {
        const paid = paidAmounts[sub.id] || 0;
        return targetClassInfo
          ? !isClassCovered(sub, targetClassInfo.match, CLASS_INFO, paid, overrides, termConfig)
          : !isFullyCovered(sub, CLASS_INFO, paid, overrides, termConfig);
      });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });

    let sent = 0;
    let failed = 0;
    const recipients = []; // { name, email, ok }

    for (const sub of targets) {
      const to = sub.data.email || sub.email;
      const childName = (sub.data && sub.data.child_name) || '(no name)';
      if (!to) { failed++; recipients.push({ name: childName, email: '(no email)', ok: false }); continue; }

      let paymentUrl = null, priceStr = '';
      if (includePaymentButton) {
        // Use the specific class this chase is for when there is one —
        // re-matching against the submission's full class string here would
        // risk picking a different class than the one actually being
        // chased for a family enrolled in more than one.
        let classInfo = targetClassInfo;
        if (!classInfo) {
          const cls = sub.data && sub.data.class;
          const classStr = Array.isArray(cls) ? cls.join(' ') : String(cls || '');
          classInfo = CLASS_INFO.find(c => classStr.includes(c.match));
        }
        if (classInfo) {
          const pence = resolvePence(overrides, sub.id, classInfo, termConfig);
          priceStr = pence ? `£${(pence / 100).toFixed(2)}` : '';
          try {
            paymentUrl = await createPaymentLink({
              classInfo, pence, termName: termConfig.termName, childName: sub.data.child_name, submissionId: sub.id, siteUrl,
            });
          } catch (err) {
            console.warn(`broadcast-message: Square link failed for ${sub.id}:`, err.message);
          }
        }
      }

      try {
        await transporter.sendMail({
          from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
          to,
          bcc: process.env.GMAIL_USER,
          subject,
          html: emailHtml(subject, message, paymentUrl, priceStr),
        });
        sent++;
        recipients.push({ name: childName, email: to, ok: true });
      } catch (err) {
        console.error('Failed to send to', to, err.message);
        failed++;
        recipients.push({ name: childName, email: to, ok: false });
      }
    }

    // Summary receipt — one email listing every name/address this broadcast
    // went to (and any that failed), separate from the per-recipient BCC
    // copies above.
    try {
      const rows = recipients.map(r =>
        `<tr><td style="padding:4px 10px;border-bottom:1px solid #e0d8c8">${r.ok ? '✅' : '❌'}</td><td style="padding:4px 10px;border-bottom:1px solid #e0d8c8">${(r.name || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</td><td style="padding:4px 10px;border-bottom:1px solid #e0d8c8">${(r.email || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</td></tr>`
      ).join('');
      const receiptHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;color:#333;padding:20px">
  <h2 style="margin:0 0 4px">Broadcast sent: ${subject}</h2>
  <p style="margin:0 0 16px;color:#666">${sent} sent, ${failed} failed — ${recipients.length} total recipients.</p>
  <table style="border-collapse:collapse;font-size:14px;width:100%;max-width:600px">
    <tr style="background:#f5f0e8"><th style="padding:4px 10px;text-align:left">Status</th><th style="padding:4px 10px;text-align:left">Name</th><th style="padding:4px 10px;text-align:left">Email</th></tr>
    ${rows}
  </table>
</body></html>`;
      await transporter.sendMail({
        from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
        to: contact.email,
        subject: `Send receipt: "${subject}" (${sent} sent, ${failed} failed)`,
        html: receiptHtml,
      });
    } catch (err) {
      console.error('broadcast-message: failed to send receipt email:', err.message);
    }

    return { statusCode: 200, body: JSON.stringify({ sent, failed }) };
  } catch (err) {
    console.error('broadcast-message error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
