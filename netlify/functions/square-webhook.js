const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const SQUARE_API_VERSION = '2026-05-20';

function signatureMatches(signature, expected) {
  try {
    const supplied = Buffer.from(signature, 'base64');
    const calculated = Buffer.from(expected, 'base64');
    return supplied.length === calculated.length &&
      crypto.timingSafeEqual(supplied, calculated);
  } catch {
    return false;
  }
}

async function getSubmissionIdFromOrder(orderId) {
  if (!orderId || !process.env.SQUARE_ACCESS_TOKEN) return null;

  const response = await fetch(`https://connect.squareup.com/v2/orders/${orderId}`, {
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_API_VERSION,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Square order lookup failed (${response.status})`);
  }

  const { order } = await response.json();
  if (order?.reference_id) return order.reference_id;

  for (const item of order?.line_items || []) {
    const match = (item.note || '').match(/booking:([a-z0-9-]+)/i);
    if (match) return match[1];
  }

  return null;
}

// Reusable class payment links (class-payment-links.js) aren't tied to any
// family — they're tagged `classlink:{classMatch}` instead of a real
// submission id. When one of them gets paid, try to auto-match the payment
// back to an existing registration by the buyer's email (captured by
// Square at checkout), and if found, convert that registration's class via
// the same registration-overrides store the Register/Revenue UI reads —
// same pattern as the trial follow-up conversion.
async function findRegistrationByEmail(email) {
  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const emailKey = email.toLowerCase().trim();
  if (!emailKey) return null;

  const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/forms`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const forms = await formsRes.json();
  const regForm = Array.isArray(forms) ? forms.find(f => f.name === 'registration') : null;
  if (!regForm) return null;

  const subRes = await fetch(`https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const submissions = await subRes.json();
  if (!Array.isArray(submissions)) return null;

  const matches = submissions.filter(s => (s.data?.email || '').toLowerCase().trim() === emailKey);
  if (matches.length === 0) return null;
  // Most recent registration for this email.
  matches.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return matches[0];
}

// `matches` is a single class match key or an array of them — merged with
// (not replacing) whatever class(es) this submission is already on record
// for, so a second class-link payment (a different class, or a cart with
// several) adds to their enrolment instead of wiping out an earlier one.
async function applyClassOverride(submissionId, matches) {
  const store = getStore({ name: 'settings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_ACCESS_TOKEN });
  const current = await store.get('registration-overrides', { type: 'json', consistency: 'strong' }).catch(() => ({})) || {};
  const existing = current[submissionId] && current[submissionId].class;
  const existingList = Array.isArray(existing) ? existing : (existing ? [existing] : []);
  const toAdd = Array.isArray(matches) ? matches : [matches];
  const merged = [...new Set([...existingList, ...toAdd])];
  current[submissionId] = { ...(current[submissionId] || {}), class: merged };
  await store.setJSON('registration-overrides', current);
}

// trial-checkout.js bundles every trial fee in one wizard submission into a
// single Square order, since the real Netlify Forms submission id for each
// child isn't known client-side yet — each line item is tagged
// `trialpay:{email}|{childName}|{classMatch}` instead. Resolve each one back
// to its actual registration by matching email + exact child name (most
// recent submission wins if there happen to be several).
async function findRegistrationByEmailAndChildName(email, childName) {
  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const emailKey = email.toLowerCase().trim();
  const nameKey = childName.toLowerCase().trim();
  if (!emailKey || !nameKey) return null;

  const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/forms`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const forms = await formsRes.json();
  const regForm = Array.isArray(forms) ? forms.find(f => f.name === 'registration') : null;
  if (!regForm) return null;

  const subRes = await fetch(`https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const submissions = await subRes.json();
  if (!Array.isArray(submissions)) return null;

  const matches = submissions.filter(s =>
    (s.data?.email || '').toLowerCase().trim() === emailKey &&
    (s.data?.child_name || '').toLowerCase().trim() === nameKey
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return matches[0];
}

async function getOrderLineItemNotes(orderId) {
  const response = await fetch(`https://connect.squareup.com/v2/orders/${orderId}`, {
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_API_VERSION,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) throw new Error(`Square order lookup failed (${response.status})`);
  const { order } = await response.json();
  return (order?.line_items || []).map(item => item.note || '').filter(Boolean);
}

// Marks every child in a combined trial checkout as paid — same payment
// record (amount/receipt aren't split per child, "paid" is just a presence
// flag) written under each resolved submission id.
async function handleTrialPayOrder(orderId, paymentRecordBase) {
  const notes = await getOrderLineItemNotes(orderId);
  const store = getStore({ name: 'payments', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_ACCESS_TOKEN });
  const resolvedIds = [];

  for (const note of notes) {
    const m = note.match(/^trialpay:([^|]+)\|([^|]+)\|(.+)$/);
    if (!m) continue;
    const [, email, encodedChildName] = m;
    const childName = decodeURIComponent(encodedChildName);
    try {
      const matched = await findRegistrationByEmailAndChildName(email, childName);
      if (matched) {
        await store.setJSON(`submission:${matched.id}`, { ...paymentRecordBase, submissionId: matched.id });
        resolvedIds.push(matched.id);
        console.log(`trialpay: matched ${email} / ${childName} to registration ${matched.id}`);
      } else {
        console.log(`trialpay: no registration found for ${email} / ${childName}`);
      }
    } catch (err) {
      console.error(`trialpay: lookup failed for ${email} / ${childName}:`, err.message);
    }
  }

  return resolvedIds;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── Parse body first ─────────────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const eventType = payload.type;
  const payment = payload.data?.object?.payment;

  // ── Log for debugging ─────────────────────────────────────────────────────────
  console.log('square-webhook received eventType:', eventType);
  console.log('payment status:', payment?.status, 'id:', payment?.id);

  // ── Verify Square webhook signature ──────────────────────────────────────────
  const sigHeader = event.headers['x-square-hmacsha256-signature'] ||
    event.headers['X-Square-HmacSha256-Signature'];
  const sigKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

  if (!sigKey || !sigHeader) {
    console.error('Missing Square webhook signature or signature key');
    return { statusCode: 401, body: 'Webhook signature required' };
  }

  // Square signs the exact notification URL configured in its dashboard.
  const urls = [
    process.env.SQUARE_WEBHOOK_NOTIFICATION_URL,
    'https://www.championgymnastics.co.uk/.netlify/functions/square-webhook',
    'https://championgymnastics.co.uk/.netlify/functions/square-webhook',
    'https://championdevelopment.netlify.app/.netlify/functions/square-webhook',
  ].filter(Boolean);

  let verified = false;
  for (const url of [...new Set(urls)]) {
    try {
      const hmac = crypto.createHmac('sha256', sigKey);
      hmac.update(url + event.body);
      const expected = hmac.digest('base64');
      if (signatureMatches(sigHeader, expected)) {
        verified = true;
        break;
      }
    } catch {
      // Try the next configured URL.
    }
  }

  if (!verified) {
    console.error('Square webhook signature mismatch');
    return { statusCode: 401, body: 'Invalid webhook signature' };
  }

  // ── Handle 100% discount / zero-value orders via order.updated ──────────────
  if (eventType === 'order.updated') {
    const order = payload.data?.object?.order_updated || payload.data?.object?.order;
    const orderId = order?.order_id || order?.id;
    if (!orderId) return { statusCode: 200, body: 'No order id' };

    // Fetch the full order to check if it's fully covered (net_amount_due = 0)
    try {
      const res = await fetch(`https://connect.squareup.com/v2/orders/${orderId}`, {
        headers: {
          Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': SQUARE_API_VERSION,
        },
      });
      const { order: fullOrder } = await res.json();
      const state = fullOrder?.state;
      const netDue = fullOrder?.net_amount_due_money?.amount ?? null;
      if (state !== 'COMPLETED' || netDue !== 0) {
        return { statusCode: 200, body: `Order not fully paid (state=${state} netDue=${netDue})` };
      }

      let submissionId = fullOrder.reference_id || null;
      if (!submissionId) {
        for (const item of fullOrder.line_items || []) {
          const m = (item.note || '').match(/booking:([a-z0-9-]+)/i);
          if (m) { submissionId = m[1]; break; }
        }
      }

      console.log(`Zero-value order COMPLETED: ${orderId} submissionId=${submissionId}`);

      const store = getStore({ name: 'payments', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_ACCESS_TOKEN });
      const record = { paymentId: `order-${orderId}`, amountPence: 0, currency: 'GBP', buyerEmail: '', receiptUrl: null, createdAt: new Date().toISOString(), submissionId, orderId };
      await store.setJSON(`payment:order-${orderId}`, record);
      if (submissionId) await store.setJSON(`submission:${submissionId}`, record);
      return { statusCode: 200, body: JSON.stringify({ received: true, submissionId, zeroValue: true }) };
    } catch (err) {
      console.error('order.updated handling error:', err.message);
      return { statusCode: 500, body: err.message };
    }
  }

  // ── Filter payment events ─────────────────────────────────────────────────────
  if (eventType !== 'payment.completed' && eventType !== 'payment.updated' && eventType !== 'payment.created') {
    return { statusCode: 200, body: 'Ignored event type: ' + eventType };
  }

  if (!payment || payment.status !== 'COMPLETED') {
    console.log('Payment not COMPLETED, status:', payment?.status);
    return { statusCode: 200, body: 'Payment not completed, status: ' + payment?.status };
  }

  // ── Extract payment details ───────────────────────────────────────────────────
  const paymentId   = payment.id;
  const amountPence = payment.amount_money?.amount || 0;
  const currency    = payment.amount_money?.currency || 'GBP';
  const buyerEmail  = (payment.buyer_email_address || '').toLowerCase().trim();
  const receiptUrl  = payment.receipt_url || null;
  const createdAt   = payment.created_at || new Date().toISOString();
  const orderId     = payment.order_id || null;

  // Extract booking reference from note or reference_id
  let submissionId = null;
  const note = payment.note || '';
  const noteMatch = note.match(/booking:([a-z0-9-]+)/i);
  if (noteMatch) submissionId = noteMatch[1];
  if (!submissionId && payment.reference_id) submissionId = payment.reference_id;
  if (!submissionId && orderId) {
    try {
      submissionId = await getSubmissionIdFromOrder(orderId);
    } catch (err) {
      console.error('Could not recover registration from Square order:', err.message);
    }
  }

  // A combined trial-fee checkout (trial-checkout.js) covers one or more
  // children in a single order — resolve each one separately and skip the
  // normal single-submissionId storage below.
  if (submissionId && submissionId.startsWith('trialpay:') && orderId) {
    console.log(`Payment COMPLETED: ${paymentId} £${(amountPence/100).toFixed(2)} from ${buyerEmail} (combined trial checkout)`);
    try {
      const store = getStore({ name: 'payments', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_ACCESS_TOKEN });
      const record = { paymentId, amountPence, currency, buyerEmail, receiptUrl, createdAt, submissionId: null, orderId };
      await store.setJSON(`payment:${paymentId}`, record);
      const resolvedIds = await handleTrialPayOrder(orderId, record);
      return { statusCode: 200, body: JSON.stringify({ received: true, resolvedIds }) };
    } catch (err) {
      console.error('trialpay: handling failed:', err.message);
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  // members.html's "Pay Fees" cart (create-checkout.js) bundles one or more
  // classes into a single order tagged reference_id 'classcart', with each
  // class line item noted `classlink:{match}` (same convention as the
  // single-class payment links below) — lets a trial family pay for an
  // ongoing class straight from the members area without filling in a new
  // registration form. Resolve every class bought back to the buyer's most
  // recent registration by email and convert it, same as a coach's "Move to
  // class".
  if (submissionId === 'classcart' && orderId) {
    submissionId = null;
    try {
      const notes = await getOrderLineItemNotes(orderId);
      const classMatches = notes
        .map(n => (n.match(/^classlink:(.+)$/) || [])[1])
        .filter(Boolean);
      if (classMatches.length && buyerEmail) {
        const matched = await findRegistrationByEmail(buyerEmail);
        if (matched) {
          submissionId = matched.id;
          await applyClassOverride(matched.id, classMatches);
          console.log(`classcart: matched ${buyerEmail} to registration ${matched.id}, added classes ${classMatches.join(', ')}`);
        } else {
          console.log(`classcart: no existing registration found for ${buyerEmail}`);
        }
      }
    } catch (err) {
      console.error('classcart: auto-match failed:', err.message);
    }
  }

  // A generic class payment link (not tied to any family) was used — try to
  // auto-match it back to an existing registration via the buyer's email.
  if (submissionId && submissionId.startsWith('classlink:')) {
    const targetClassMatch = submissionId.slice('classlink:'.length);
    submissionId = null;
    if (buyerEmail) {
      try {
        const matched = await findRegistrationByEmail(buyerEmail);
        if (matched) {
          submissionId = matched.id;
          await applyClassOverride(matched.id, targetClassMatch);
          console.log(`class-payment-link: matched ${buyerEmail} to registration ${matched.id}, converted to ${targetClassMatch}`);
        } else {
          console.log(`class-payment-link: no existing registration found for ${buyerEmail}`);
        }
      } catch (err) {
        console.error('class-payment-link: auto-match failed:', err.message);
      }
    }
  }

  console.log(`Payment COMPLETED: ${paymentId} £${(amountPence/100).toFixed(2)} from ${buyerEmail} submissionId=${submissionId}`);

  // ── Store in Netlify Blobs ────────────────────────────────────────────────────
  try {
    const store = getStore({
      name: 'payments',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });

    const record = {
      paymentId, amountPence, currency, buyerEmail,
      receiptUrl, createdAt, submissionId, orderId,
    };

    await store.setJSON(`payment:${paymentId}`, record);
    console.log('Stored payment:', paymentId);

    if (submissionId) {
      await store.setJSON(`submission:${submissionId}`, record);
      console.log('Stored by submissionId:', submissionId);
    }

    if (buyerEmail) {
      const emailKey = `email:${buyerEmail}`;
      let existing = [];
      try { existing = await store.get(emailKey, { type: 'json' }) || []; } catch {}
      if (!existing.includes(paymentId)) existing.push(paymentId);
      await store.setJSON(emailKey, existing);
      console.log('Stored by email:', buyerEmail);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true, submissionId }) };

  } catch (err) {
    console.error('Blobs error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
