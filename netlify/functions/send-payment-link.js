const nodemailer = require('nodemailer');
const { validatePin } = require('./_coach-auth');
const { identity, contact } = require('../../club.config');
const { getTermConfig } = require('./_term-config');
const { requireFeature } = require('./_require-feature');

const SQUARE_API_VERSION = '2026-05-20';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const blocked = requireFeature('payments');
  if (blocked) return blocked;

  // Simple PIN check so only coaches can trigger this
  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const termConfig = await getTermConfig();
  const CLASS_INFO = termConfig.classes;
  const termName = termConfig.termName;

  const { submissionId } = body;
  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }
  if (!submissionId) {
    return { statusCode: 400, body: 'Missing submissionId' };
  }

  // Fetch the submission from Netlify Forms API
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID;
  if (!token || !siteId) {
    return { statusCode: 500, body: 'Missing env vars' };
  }

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
    console.error('Fetch submission error:', err.message);
    return { statusCode: 500, body: 'Could not fetch submission' };
  }

  if (!data.email) {
    return { statusCode: 400, body: 'Submission has no email address' };
  }

  // Match classes
  const rawClass = data.class || '';
  const classStrs = Array.isArray(rawClass) ? rawClass : (rawClass ? [rawClass] : []);
  const classInfos = classStrs
    .map(cs => CLASS_INFO.find(c => cs.includes(c.match)))
    .filter(Boolean);

  const payableClasses = classInfos.filter(ci => ci.pence > 0);
  const totalPence = payableClasses.reduce((sum, ci) => sum + ci.pence, 0);
  const totalStr = totalPence > 0 ? `£${(totalPence / 100).toFixed(2)}` : '';

  if (payableClasses.length === 0) {
    return { statusCode: 400, body: 'No payable classes found for this submission' };
  }

  // Generate Square payment link
  let paymentUrl;
  try {
    const res = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': SQUARE_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: `cgy-manual-${submissionId}-${Date.now()}`,
        order: {
          location_id: process.env.SQUARE_LOCATION_ID,
          reference_id: submissionId,
          line_items: payableClasses.map(ci => ({
            name: `${ci.label}${ci.trial ? '' : ` - ${termName}`}${data.child_name ? ` (${data.child_name})` : ''}`,
            quantity: '1',
            base_price_money: { amount: ci.pence, currency: 'GBP' },
            note: `booking:${submissionId}`,
          })),
        },
        checkout_options: {
          redirect_url: `${process.env.SITE_URL || 'https://www.championgymnastics.co.uk'}/index.html?paid=1#contact`,
          ask_for_shipping_address: false,
          merchant_support_email: contact.email,
          custom_fields: [{ title: "Child's full name" }],
        },
      }),
    });
    const result = await res.json();
    if (!res.ok) {
      const details = (result.errors || []).map(e => `${e.code}: ${e.detail || e.category}`).join('; ');
      throw new Error(`Square API ${res.status}${details ? ` - ${details}` : ''}`);
    }
    paymentUrl = result.payment_link?.url;
    if (!paymentUrl) throw new Error('No URL in Square response');
  } catch (err) {
    console.error('Square error:', err.message);
    return { statusCode: 500, body: `Square error: ${err.message}` };
  }

  // Build class summary rows for email
  const classRows = payableClasses.map(ci => `
    <tr>
      <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0">${ci.label}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0;white-space:nowrap">${ci.schedule}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0;text-align:right;white-space:nowrap">£${(ci.pence/100).toFixed(2)}</td>
    </tr>`).join('');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1A2B5E">
    <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
      <img src="${process.env.SITE_URL}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto 4px;width:160px;height:auto" />
    </div>
    <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
      <p>Hi ${data.parent_name || 'there'},</p>
      <p>Here is your payment link for <strong>${data.child_name || 'your child'}</strong>'s gymnastics class${payableClasses.length > 1 ? 'es' : ''}:</p>

      <div style="background:#ffffff;border:2px solid #E8E0F0;border-radius:14px;padding:16px 18px;margin:18px 0">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#F5F0FF">
              <th style="padding:5px 8px;text-align:left;border-bottom:2px solid #E8E0F0">Class</th>
              <th style="padding:5px 8px;text-align:left;border-bottom:2px solid #E8E0F0">When</th>
              <th style="padding:5px 8px;text-align:right;border-bottom:2px solid #E8E0F0">Fee</th>
            </tr>
          </thead>
          <tbody>${classRows}</tbody>
          <tfoot><tr style="background:#FFF8E8"><td colspan="2" style="padding:6px 8px;font-weight:bold">Total</td><td style="padding:6px 8px;text-align:right;font-weight:bold">${totalStr}</td></tr></tfoot>
        </table>
      </div>

      <div style="text-align:center;margin:22px 0">
        <a href="${paymentUrl}" style="background:#F5A623;color:#111C3E;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 30px;border-radius:50px;display:inline-block">Pay Now — ${totalStr} 🔒</a>
      </div>
      <p style="font-size:13px;color:#7A7A8A;text-align:center;margin-top:-10px">Secure payment via Square.</p>

      <p style="font-size:13px;color:#7A7A8A">If you've already paid for all of ${data.child_name || 'your child'}'s registered classes, please ignore this email.</p>
      <p>If you have any questions, reply to this email or contact us at <a href="mailto:${contact.email}" style="color:#1A2B5E">${contact.email}</a>.</p>
      <p style="margin-top:24px">${identity.name} 🤸</p>
    </div>
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
      from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
      to: data.email,
      subject: `Payment link for ${data.child_name || 'your child'}'s gymnastics class — ${identity.name}`,
      html,
    });
  } catch (err) {
    console.error('Email error:', err.message);
    return { statusCode: 500, body: 'Payment link created but email failed' };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, totalStr }) };
};
