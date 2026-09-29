const nodemailer = require('nodemailer');
const { getTermConfig } = require('./_term-config');
const { recordOriginalPricing } = require('./_registration-pricing');
const { currentPence } = require('./_prorated-pricing');
const { identity, contact } = require('../../club.config');

const SQUARE_API_VERSION = '2026-05-20';

// Display-only suffix appended to the Square line-item name and used to pick
// out which date-range blurb to show in the confirmation email. Not pricing
// data — that always comes live from getTermConfig(), so a Term Wizard price
// change is reflected on the very next registration instead of staying
// stuck on whatever pence value was hardcoded here at deploy time.
const TERM_SUFFIX_BY_MATCH = {
  'Reception–Year 3), Term 2': ' - 2nd half of term',
  'Year 4+), Term 2': ' - 2nd half of term',
  'Year 7+), Term 2': ' - 2nd half of term',
  'Minis': ' - 1st half of term',
  'Juniors': ' - 1st half of term',
  'Seniors': ' - 1st half of term',
  'Year 1 & 2 (Wed': ' - Autumn Term',
  'Year 3 (Wed': ' - Autumn Term',
  'Year 4–6': ' - Autumn Term',
};

async function createPaymentLink({ classInfos, data, submissionId, totalPence }) {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;

  if (!accessToken || !locationId) {
    throw new Error('SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID is not set');
  }

  const response = await fetch(
    'https://connect.squareup.com/v2/online-checkout/payment-links',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: `cgy-reg-${submissionId || Date.now()}`,
        order: {
          location_id: locationId,
          reference_id: submissionId || undefined,
          line_items: classInfos.map(ci => ({
            name: `${ci.name}${ci.termSuffix || ''}${data.child_name ? ` (${data.child_name})` : ''}`,
            quantity: '1',
            base_price_money: { amount: ci.pence, currency: 'GBP' },
            note: submissionId ? `booking:${submissionId}` : undefined,
          })),
        },
        checkout_options: {
          redirect_url: `${process.env.SITE_URL || 'https://www.championgymnastics.co.uk'}/index.html?paid=1#contact`,
          ask_for_shipping_address: false,
          merchant_support_email: contact.email,
          custom_fields: [{ title: "Child's full name" }],
        },
      }),
    }
  );

  const result = await response.json();
  if (!response.ok) {
    const details = (result.errors || [])
      .map(e => `${e.code}: ${e.detail || e.category}`)
      .join('; ');
    throw new Error(`Square API ${response.status}${details ? ` - ${details}` : ''}`);
  }

  const url = result.payment_link?.url;
  if (!url) throw new Error('Square did not return a payment link URL');
  return url;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const data = body.data || (body.payload && body.payload.data) || body;
  const formName = body.form_name || (body.payload && body.payload.form_name);
  const submissionId = body.id || (body.payload && body.payload.id) || null;

  if (formName && formName !== 'registration') {
    return { statusCode: 200, body: 'Ignored - not registration form' };
  }

  if (!data || !data.email) {
    console.error('No email found in submission:', JSON.stringify(body).slice(0, 500));
    return { statusCode: 200, body: 'No email - skipping' };
  }

  const config = await getTermConfig();

  // Support single class (string) or multiple classes (array). Sorted
  // longest-match-first so a specific key (e.g. the Term 2 variants) can't
  // be shadowed by a shorter one (e.g. "Minis") when checking a submitted
  // class string for which entry it belongs to.
  const CLASS_INFO = [...config.classes]
    .sort((a, b) => b.match.length - a.match.length)
    .map(c => ({ ...c, name: c.label, termSuffix: TERM_SUFFIX_BY_MATCH[c.match] || '' }));

  const rawClass = data.class || '';
  const classStrs = Array.isArray(rawClass) ? rawClass : (rawClass ? [rawClass] : []);
  // Charge whatever the class actually costs today — pro-rated down if
  // sessions have already run, same as the price the registration page
  // showed this family before they submitted (see _prorated-pricing.js).
  const classInfos = classStrs
    .map(cs => CLASS_INFO.find(c => cs.includes(c.match)))
    .filter(Boolean)
    .map(ci => ({ ...ci, pence: currentPence(config, ci) }));

  const totalPence = classInfos.reduce((sum, ci) => sum + ci.pence, 0);
  const totalStr = totalPence > 0 ? `£${(totalPence / 100).toFixed(2)}` : '';
  const hasTrial = classInfos.some(ci => ci.trial);
  const payableClasses = classInfos.filter(ci => ci.pence > 0);

  // Lock in today's price for this family — a later Term Wizard change
  // must never alter what they were quoted at registration.
  try {
    await recordOriginalPricing(submissionId, classInfos);
  } catch (err) {
    console.error('Could not record original pricing:', err.message);
  }

  // Generate Square payment link for all payable classes in one link
  let paymentUrl = null;
  if (payableClasses.length > 0) {
    try {
      paymentUrl = await createPaymentLink({ classInfos: payableClasses, data, submissionId, totalPence });
    } catch (err) {
      console.error('Square error:', err.message);
    }
  }

  // Build class rows for email
  const classRows = classInfos.length > 0
    ? classInfos.map(ci => `
        <tr>
          <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0">${ci.name}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0;white-space:nowrap">${ci.schedule}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0;text-align:right;white-space:nowrap">${ci.pence > 0 ? `£${(ci.pence/100).toFixed(2)}` : 'Register interest'}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:5px 8px">${classStrs.join(', ') || '—'}</td></tr>`;

  const termDatesRow = classInfos.some(ci => !ci.trial && ci.schedule.includes('Wednesday'))
    ? `<p style="margin:5px 0"><strong>Wed term dates:</strong> ${config.termDatesDisplay} (no class 28 Oct – half-term)</p>`
    : '';
  const fridayHalf1 = config.classes.find(c => c.match === 'Minis');
  const fridayHalf2 = config.classes.find(c => c.match === 'Reception–Year 3), Term 2');
  const fridayDatesRow = classInfos.some(ci => !ci.trial && ci.schedule.includes('Friday')) && fridayHalf1 && fridayHalf2
    ? `<p style="margin:5px 0"><strong>Fri term dates (one term, booked in two halves):</strong> 1st half: Fri 18 Sep – 23 Oct (£${(fridayHalf1.pence / 100).toFixed(2)}) · 2nd half: Fri 6 Nov – 18 Dec (£${(fridayHalf2.pence / 100).toFixed(2)})</p>`
    : '';

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1A2B5E">
    <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
      <img src="${process.env.SITE_URL}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto 4px;width:160px;height:auto" />
    </div>
    <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
      <p>Hi ${data.parent_name || 'there'},</p>
      <p>Thanks for signing up <strong>${data.child_name || 'your child'}</strong> — we can't wait to see them on the mat! Here's a summary of the registration:</p>

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
          ${totalPence > 0 ? `<tfoot><tr style="background:#FFF8E8"><td colspan="2" style="padding:6px 8px;font-weight:bold">Total</td><td style="padding:6px 8px;text-align:right;font-weight:bold">${totalStr}</td></tr></tfoot>` : ''}
        </table>
        <p style="margin:10px 0 5px 0"><strong>Where:</strong> Knavesmire Primary School, Trafalgar Street, York, YO23 1HY</p>
        ${termDatesRow}
        ${fridayDatesRow}
      </div>

      ${totalPence > 0 ? `
      <div style="background:#FFF3CD;border:2px solid #F5A623;border-radius:14px;padding:14px 18px;margin:18px 0">
        <p style="margin:0 0 6px 0;font-weight:bold;color:#8B5E00">⚠️ Your child's place is not guaranteed until fees have been paid.</p>
        <p style="margin:0;font-size:13px;color:#7A5200">${hasTrial ? 'Trial fees must be paid to secure the spot.' : 'Spaces are limited, so please pay soon to secure the place — if the class fills up with families who\'ve already paid before we hear from you, your child\'s place will be released and you\'ll be moved to the waiting list.'}</p>
      </div>
      ` : ''}

      ${paymentUrl ? `
      <div style="text-align:center;margin:22px 0">
        <a href="${paymentUrl}" style="background:#F5A623;color:#111C3E;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 30px;border-radius:50px;display:inline-block">Pay Now — ${totalStr} 🔒</a>
      </div>
      <p style="font-size:13px;color:#7A7A8A;text-align:center;margin-top:-10px">Secure payment via Square. This link is unique to ${data.child_name || 'your child'}'s registration.</p>
      ` : (totalPence > 0 ? `<p>We'll be in touch shortly with payment details.</p>` : '')}

      <div style="background:#111C3E;border-radius:14px;padding:16px 18px;margin:18px 0">
        <div style="color:#F5A623;font-weight:bold;font-size:14px;margin-bottom:8px;letter-spacing:0.5px">WHAT TO BRING 🎒</div>
        <ul style="list-style:none;padding:0;margin:0;color:rgba(255,255,255,0.85);font-size:13px;font-weight:600;line-height:1.9">
          <li>👕 Comfortable sports clothing — t-shirt, shorts, leggings or leotard</li>
          <li>💧 A bottle of water</li>
          <li>💇 Long hair must be tied up</li>
          <li>🏫 Sessions take place inside the school hall</li>
        </ul>
      </div>

      <p>If anything above doesn't look right, or you have any questions, just reply to this email or contact us at <a href="mailto:${contact.email}" style="color:#1A2B5E">${contact.email}</a>.</p>

      <p style="margin-top:24px">See you on the mat! 🤸<br><strong>${identity.name}</strong></p>
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
      subject: `Welcome to ${identity.name}, ${data.child_name || 'champ'}! 🌟`,
      html,
    });
  } catch (err) {
    console.error('Email error:', err);
    return { statusCode: 500, body: 'Failed to send email' };
  }

  return { statusCode: 200, body: 'OK' };
};
