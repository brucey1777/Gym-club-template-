const { getStore } = require('@netlify/blobs');
const { requireFeature } = require('./_require-feature');
const { identity, contact } = require('../../club.config');
const nodemailer = require('nodemailer');
const { getTermConfig } = require('./_term-config');
const { resolvePence } = require('./_registration-pricing');
const { enrolledPayableClasses, classesCoveredByPayment, isFullyCovered } = require('./_payment-coverage-lib');

// Runs daily at 9am UTC via the schedule in netlify.toml. There's no
// site-wide payment deadline any more — each family gets a few gentle,
// evenly-spaced nudges counted from when *they* registered, then automated
// chasing stops for good (capacity-warning.js and waitlist-unpaid.js still
// apply separately if their class actually fills up).
const REMINDER_DAYS_SINCE_REGISTRATION = [3, 10, 21];
const SQUARE_API_VERSION = '2026-05-20';

async function squareRequest(path) {
  const response = await fetch(`https://connect.squareup.com${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_API_VERSION,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error(`Square API ${response.status}`);
  return response.json();
}

function submissionIdFromOrder(order) {
  if (order?.reference_id) return order.reference_id;
  for (const item of order?.line_items || []) {
    const match = (item.note || '').match(/booking:([a-z0-9-]+)/i);
    if (match) return match[1];
  }
  return null;
}

async function reconcileSquarePayments(store, knownPaymentIds) {
  if (!process.env.SQUARE_ACCESS_TOKEN || !process.env.SQUARE_LOCATION_ID) return 0;

  const params = new URLSearchParams({
    location_id: process.env.SQUARE_LOCATION_ID,
    limit: '100',
    sort_order: 'DESC',
  });
  const { payments = [] } = await squareRequest(`/v2/payments?${params}`);
  const candidates = payments.filter(payment =>
    payment.status === 'COMPLETED' &&
    payment.order_id &&
    !knownPaymentIds.has(payment.id)
  );

  let linked = 0;
  // Keep concurrency modest so this remains friendly to Square's API limits.
  for (let i = 0; i < candidates.length; i += 5) {
    const batch = candidates.slice(i, i + 5);
    const results = await Promise.all(batch.map(async payment => {
      try {
        const { order } = await squareRequest(`/v2/orders/${payment.order_id}`);
        const submissionId = submissionIdFromOrder(order);
        if (!submissionId) return false;

        const record = {
          paymentId: payment.id,
          amountPence: payment.amount_money?.amount || 0,
          currency: payment.amount_money?.currency || 'GBP',
          buyerEmail: (payment.buyer_email_address || '').toLowerCase().trim(),
          receiptUrl: payment.receipt_url || null,
          createdAt: payment.created_at || new Date().toISOString(),
          submissionId,
          orderId: payment.order_id,
        };
        await Promise.all([
          store.setJSON(`payment:${payment.id}`, record),
          store.setJSON(`submission:${submissionId}`, record),
        ]);
        return true;
      } catch (err) {
        console.warn(`Could not reconcile payment ${payment.id}:`, err.message);
        return false;
      }
    }));
    linked += results.filter(Boolean).length;
  }

  return linked;
}

exports.handler = async () => {
  const blocked = requireFeature('payments');
  if (blocked) return blocked;

  const siteId = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;

  if (!token || !siteId) {
    console.error('Missing NETLIFY_ACCESS_TOKEN or NETLIFY_SITE_ID');
    return { statusCode: 500, body: 'Missing env vars' };
  }

  const termConfig = await getTermConfig();
  const CLASS_INFO = termConfig.classes;

  const now = new Date();

  // ── Fetch all form submissions ─────────────────────────────────────────────
  let submissions = [];
  try {
    const formsRes = await fetch(
      `https://api.netlify.com/api/v1/sites/${siteId}/forms`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!formsRes.ok) throw new Error(`Forms API ${formsRes.status}`);
    const forms = await formsRes.json();
    if (!Array.isArray(forms)) throw new Error('Unexpected forms response');

    const regForm = forms.find(f => f.name === 'registration');
    if (!regForm) {
      console.log('No registration form found');
      return { statusCode: 200, body: 'No registration form' };
    }

    const subRes = await fetch(
      `https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    submissions = await subRes.json();
    if (!Array.isArray(submissions)) submissions = [];
  } catch (err) {
    console.error('Failed to fetch submissions:', err.message);
    return { statusCode: 500, body: err.message };
  }

  // Skip anyone already auto-moved to the waiting list (waitlist-unpaid.js) —
  // they no longer have a place to be reminded to pay for — and anyone a
  // coach has manually hidden from the Register (staff.html's "Move to
  // hidden" action) — hiding someone is meant to stop them being chased.
  let overrides = {};
  try {
    const settingsStore = getStore({ name: 'settings', siteID: siteId, token });
    overrides = await settingsStore.get('registration-overrides', { type: 'json' }).catch(() => ({})) || {};
    submissions = submissions.filter(s => !(overrides[s.id] && (overrides[s.id]._waitlisted || overrides[s.id]._manuallyHidden)));
    // Apply overrides before any class matching, so a converted/edited
    // registration (e.g. trial -> ongoing class) is reminded about its
    // current class, not its original one.
    submissions.forEach(s => { if (overrides[s.id]) Object.assign(s.data, overrides[s.id]); });
  } catch (err) {
    console.error('Could not check waitlisted overrides:', err.message);
  }

  // ── Fetch paid amounts from blobs ───────────────────────────────────────────
  // A submission only has one payment total, even when enrolled in several
  // payable classes — amounts (not just presence) let isFullyCovered/
  // classesCoveredByPayment tell a fully-paid family from one that's paid
  // for some of their classes but not all.
  const paidAmounts = {};
  const knownPaymentIds = new Set();
  try {
    const store = getStore({ name: 'payments', siteID: siteId, token });
    const { blobs } = await store.list();
    const submissionBlobs = blobs.filter(b => b.key.startsWith('submission:'));
    blobs.forEach(b => { if (b.key.startsWith('payment:')) knownPaymentIds.add(b.key.replace('payment:', '')); });
    const records = await Promise.all(submissionBlobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
    submissionBlobs.forEach((b, i) => {
      if (records[i]) paidAmounts[b.key.replace('submission:', '')] = records[i].amountPence || 0;
    });

    const reconciled = await reconcileSquarePayments(store, knownPaymentIds);
    if (reconciled) {
      const refreshed = await store.list({ prefix: 'submission:' });
      for (const blob of refreshed.blobs) {
        const data = await store.get(blob.key, { type: 'json' }).catch(() => null);
        if (data) paidAmounts[blob.key.replace('submission:', '')] = data.amountPence || 0;
      }
      console.log(`Recovered ${reconciled} linked payment(s) from Square`);
    }
  } catch (err) {
    // Do not send reminders when payment verification is unavailable.
    console.error('Could not verify payment status:', err.message);
    return { statusCode: 503, body: 'Payment verification unavailable' };
  }

  // ── Filter to submissions with at least one uncovered payable class ────────
  const unpaid = submissions.filter(s => !isFullyCovered(s, CLASS_INFO, paidAmounts[s.id] || 0, overrides, termConfig));
  console.log(`Total: ${submissions.length} | Fully paid: ${submissions.length - unpaid.length} | Owing: ${unpaid.length}`);

  if (!unpaid.length) {
    return { statusCode: 200, body: 'All paid — no reminders needed' };
  }

  // ── Set up mailer ──────────────────────────────────────────────────────────
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  // Every reminder reads the same polite way — no escalating "FINAL
  // REMINDER" wording.
  const urgency = '📣 Reminder';

  let sent = 0, failed = 0;

  for (const s of unpaid) {
    const data = s.data || {};
    if (!data.email) continue;

    // Nudge on a fixed schedule counted from when this family registered,
    // not a shared calendar deadline — skip unless today is one of their
    // reminder days.
    const daysSinceRegistration = s.created_at
      ? Math.floor((now - new Date(s.created_at)) / (1000 * 60 * 60 * 24))
      : null;
    if (daysSinceRegistration === null || !REMINDER_DAYS_SINCE_REGISTRATION.includes(daysSinceRegistration)) continue;

    // Only remind about classes actually still owed — a family enrolled in
    // several classes who's paid for some of them shouldn't be told their
    // paid-up class is unpaid too.
    const enrolled = enrolledPayableClasses(s, CLASS_INFO, overrides, termConfig);
    const covered = classesCoveredByPayment(enrolled, paidAmounts[s.id] || 0);
    // Trials require upfront payment — no reminder needed for those.
    const owedClasses = enrolled.filter(c => !covered.has(c.match) && !c.trial);
    if (!owedClasses.length) continue;

    const totalPence = owedClasses.reduce((sum, c) => sum + resolvePence(overrides, s.id, c, termConfig), 0);
    const priceStr = `£${(totalPence / 100).toFixed(2)}`;
    const classRows = owedClasses.map(c => `
      <tr>
        <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0">${c.label}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0;white-space:nowrap">${c.schedule}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #E8E0F0;text-align:right;white-space:nowrap">£${(resolvePence(overrides, s.id, c, termConfig)/100).toFixed(2)}</td>
      </tr>`).join('');

    // Build a fresh Square payment link covering every class still owed
    let paymentUrl = `${process.env.SITE_URL}/members.html`;
    try {
      const { Client, Environment } = require('square/legacy');
      const client = new Client({
        bearerAuthCredentials: { accessToken: process.env.SQUARE_ACCESS_TOKEN },
        environment: Environment.Production,
      });
      const { result } = await client.checkoutApi.createPaymentLink({
        idempotencyKey: `cgy-reminder-${s.id}-${Date.now()}`,
        order: {
          locationId: process.env.SQUARE_LOCATION_ID,
          referenceId: s.id,
          lineItems: owedClasses.map(c => ({
            name: `${c.label} – ${termConfig.termName}${data.child_name ? ` (${data.child_name})` : ''}`,
            quantity: '1',
            basePriceMoney: { amount: BigInt(resolvePence(overrides, s.id, c, termConfig)), currency: 'GBP' },
            note: `booking:${s.id}`,
          })),
        },
        checkoutOptions: {
          redirectUrl: `${process.env.SITE_URL}/index.html?paid=1#contact`,
          askForShippingAddress: false,
          merchantSupportEmail: contact.email,
          customFields: [{ title: "Child's full name" }],
        },
      });
      paymentUrl = result.paymentLink.url;
    } catch (err) {
      console.warn(`Square link failed for ${s.id}:`, err.message);
    }

    const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1A2B5E">
      <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
        <img src="${process.env.SITE_URL}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto;width:160px;height:auto" />
      </div>
      <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
        <p>Hi ${data.parent_name || 'there'},</p>
        <p>This is a friendly reminder that we haven't yet received payment for <strong>${data.child_name || 'your child'}</strong>'s place at ${identity.name}.</p>

        <div style="background:#FFF3CD;border:2px solid #F5A623;border-radius:14px;padding:14px 18px;margin:18px 0">
          <p style="margin:0 0 6px 0;font-weight:bold;color:#8B5E00">⚠️ Your child's place is not guaranteed until fees have been paid.</p>
          <p style="margin:0;font-size:13px;color:#7A5200">
            Spaces are limited, so if the class fills up with families who've already paid before we hear from you, we'll move you onto the waiting list.
          </p>
        </div>

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
            <tfoot><tr style="background:#FFF8E8"><td colspan="2" style="padding:6px 8px;font-weight:bold">Total</td><td style="padding:6px 8px;text-align:right;font-weight:bold">${priceStr}</td></tr></tfoot>
          </table>
        </div>

        <div style="text-align:center;margin:22px 0">
          <a href="${paymentUrl}" style="background:#F5A623;color:#111C3E;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 30px;border-radius:50px;display:inline-block">Pay Now — ${priceStr} 🔒</a>
        </div>
        <p style="font-size:13px;color:#7A7A8A;text-align:center;margin-top:-10px">Secure payment via Square.</p>

        <p style="font-size:13px;color:#7A7A8A">If you've already paid for all of ${data.child_name || 'your child'}'s registered classes, please ignore this email.</p>
        <p>If you have any questions, reply to this email or contact us at <a href="mailto:${contact.email}" style="color:#1A2B5E">${contact.email}</a>.</p>
        <p style="margin-top:24px">${identity.name} 🤸</p>
      </div>
    </div>`;

    try {
      await transporter.sendMail({
        from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
        to: data.email,
        subject: `${urgency}: ${data.child_name || 'your child'}'s gymnastics place is still unpaid`,
        html,
      });
      console.log(`Reminder sent to ${data.email} for submission ${s.id}`);
      sent++;
    } catch (err) {
      console.error(`Failed to email ${data.email}:`, err.message);
      failed++;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ sent, failed }),
  };
};
