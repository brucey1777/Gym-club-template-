const { identity, contact } = require('../../club.config');
// Shared by trial-followup.js (scheduled) and trial-followup-test.js (manual
// test send). Netlify blocks direct HTTP invocation of scheduled functions,
// so the test-send logic has to live in its own non-scheduled function —
// this file is where the two share the payment-link + email generation.

const SQUARE_API_VERSION = '2026-05-20';

async function createPaymentLink({ targetClass, termName, childName, idempotencyKey, referenceId }) {
  const res = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        reference_id: referenceId,
        line_items: [{
          name: `${targetClass.label} - ${termName}${childName ? ` (${childName})` : ''}`,
          quantity: '1',
          base_price_money: { amount: targetClass.pence, currency: 'GBP' },
          note: referenceId,
        }],
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
  const url = result.payment_link?.url;
  if (!url) throw new Error('No URL in Square response');
  return url;
}

function emailHtml({ parentName, childName, targetClass, termName, totalStr, paymentUrl }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1A2B5E">
    <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
      <img src="${process.env.SITE_URL || 'https://www.championgymnastics.co.uk'}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto 4px;width:160px;height:auto" />
    </div>
    <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
      <p>Hi ${parentName || 'there'},</p>
      <p>We hope ${childName || 'your child'} had a brilliant time at their trial session with us! We'd love to have them join us properly for <strong>${termName}</strong>.</p>

      <div style="background:#ffffff;border:2px solid #E8E0F0;border-radius:14px;padding:16px 18px;margin:18px 0">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#F5F0FF">
              <th style="padding:5px 8px;text-align:left;border-bottom:2px solid #E8E0F0">Class</th>
              <th style="padding:5px 8px;text-align:left;border-bottom:2px solid #E8E0F0">When</th>
              <th style="padding:5px 8px;text-align:right;border-bottom:2px solid #E8E0F0">Fee</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0">${targetClass.label}</td>
              <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0;white-space:nowrap">${targetClass.schedule}</td>
              <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0;text-align:right;white-space:nowrap">${totalStr}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style="text-align:center;margin:22px 0">
        <a href="${paymentUrl}" style="background:#F5A623;color:#111C3E;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 30px;border-radius:50px;display:inline-block">Secure Your Place — ${totalStr} 🔒</a>
      </div>
      <p style="font-size:13px;color:#7A7A8A;text-align:center;margin-top:-10px">Secure payment via Square.</p>

      <p>Spaces are limited, so don't wait too long! If you have any questions, just reply to this email or contact us at <a href="mailto:${contact.email}" style="color:#1A2B5E">${contact.email}</a>.</p>
      <p style="margin-top:24px">${identity.name} 🤸</p>
    </div>
  </div>`;
}

module.exports = { createPaymentLink, emailHtml };
