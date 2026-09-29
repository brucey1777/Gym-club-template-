const { identity, contact } = require('../../club.config');
// Shared by capacity-warning.js (scheduled) and capacity-warning-test.js
// (manual test send). Netlify blocks direct HTTP invocation of scheduled
// functions, so the test-send logic has to live in its own non-scheduled
// function — this file is where the two share the payment-link + email generation.

async function createPaymentLink({ classInfo, pence, termName, childName, submissionId, siteUrl }) {
  const { Client, Environment } = require('square/legacy');
  const client = new Client({
    bearerAuthCredentials: { accessToken: process.env.SQUARE_ACCESS_TOKEN },
    environment: Environment.Production,
  });
  const { result } = await client.checkoutApi.createPaymentLink({
    idempotencyKey: `cgy-capacity-warning-${submissionId}-${Date.now()}`,
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

function emailHtml({ parentName, childName, classInfo, priceStr, paymentUrl, siteUrl }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1A2B5E">
    <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
      <img src="${siteUrl}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto;width:160px;height:auto" />
    </div>
    <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
      <p>Hi ${parentName || 'there'},</p>
      <p><strong>${classInfo.label}</strong> is filling up fast, and we don't want ${childName || 'your child'} to miss out.</p>

      <div style="background:#FFF3CD;border:2px solid #F5A623;border-radius:14px;padding:14px 18px;margin:18px 0">
        <p style="margin:0 0 6px 0;font-weight:bold;color:#8B5E00">⚠️ Places are only guaranteed once paid.</p>
        <p style="margin:0;font-size:13px;color:#7A5200">
          We haven't yet received payment for ${childName || 'your child'}'s place, and this class is now almost full with families who have already paid.
          If it fills before we hear from you, we'll need to move ${childName || 'your child'} onto the waiting list.
        </p>
      </div>

      <div style="background:#ffffff;border:2px solid #E8E0F0;border-radius:14px;padding:16px 18px;margin:18px 0">
        <p style="margin:5px 0"><strong>Class:</strong> ${classInfo.label}</p>
        <p style="margin:5px 0"><strong>When:</strong> ${classInfo.schedule}</p>
        ${priceStr ? `<p style="margin:5px 0"><strong>Term fee:</strong> ${priceStr}</p>` : ''}
      </div>

      <div style="text-align:center;margin:22px 0">
        <a href="${paymentUrl}" style="background:#F5A623;color:#111C3E;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 30px;border-radius:50px;display:inline-block">Pay Now — Secure Your Place 🔒</a>
      </div>
      <p style="font-size:13px;color:#7A7A8A;text-align:center;margin-top:-10px">Secure payment via Square.</p>

      <p style="font-size:13px;color:#7A7A8A">If you've already paid for all of ${childName || 'your child'}'s registered classes, please ignore this email.</p>
      <p>If you'd like any help, just reply to this email or contact us at <a href="mailto:${contact.email}" style="color:#1A2B5E">${contact.email}</a> — we're happy to help.</p>
      <p style="margin-top:24px">${identity.name} 🤸</p>
    </div>
  </div>`;
}

module.exports = { createPaymentLink, emailHtml };
