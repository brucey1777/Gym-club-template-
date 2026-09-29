const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { contact } = require('../../club.config');
const { requireFeature } = require('./_require-feature');
const { getTermConfig } = require('./_term-config');

const SQUARE_API_VERSION = '2026-05-20';

// Called by the registration wizard immediately after a successful submit,
// for any child whose registration includes a trial or other "pay now"
// class (see _term-config.js's `payNow` flag — currently trials and
// private lessons) — builds ONE combined Square checkout covering every
// such fee in that submission and returns the URL for the browser to
// redirect to straight away, instead of relying on the follow-up email's
// payment link. Any other classes in the same submission are unaffected
// and still get the usual deferred payment link. Public (no PIN) since
// it's called by parents mid-registration, so it's rate-limited like
// waiting-list.js and never trusts a client-supplied price — pence always
// comes from the live term config.
//
// Each line item is tagged `trialpay:{email}|{childName}|{classMatch}` (not
// a real Netlify Forms submission id, which isn't known client-side yet) —
// square-webhook.js resolves each one back to its actual registration by
// matching email + child name once the Netlify Forms submission exists.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const blocked = requireFeature('payments');
  if (blocked) return blocked;

  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;

  const rlStore = getStore({ name: 'rate-limits', siteID: siteId, token });
  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';
  const rlKey = `trial-checkout:${ip}`;
  try {
    const existing = await rlStore.get(rlKey, { type: 'json' }).catch(() => null);
    const now = Date.now();
    if (existing && existing.count >= 5 && (now - existing.first) < 3600000) {
      return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests' }) };
    }
    await rlStore.setJSON(rlKey, { count: (existing?.count || 0) + 1, first: existing?.first || now });
  } catch (err) {
    console.error('trial-checkout: rate limit check failed:', err.message);
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const email = (body.email || '').trim();
  const children = Array.isArray(body.children) ? body.children : [];
  if (!email || !children.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email and children are required' }) };
  }

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!accessToken || !locationId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Square is not configured' }) };
  }

  try {
    const termConfig = await getTermConfig();
    const CLASS_INFO = [...termConfig.classes].sort((a, b) => b.match.length - a.match.length);

    const lineItems = [];
    for (const child of children) {
      const childName = (child.child_name || '').trim();
      const classStrs = Array.isArray(child.classes) ? child.classes : [];
      if (!childName || !classStrs.length) continue;

      const payNowInfos = classStrs
        .map(cs => CLASS_INFO.find(c => (c.trial || c.payNow) && cs.includes(c.match)))
        .filter(Boolean);

      for (const ci of payNowInfos) {
        lineItems.push({
          name: `${ci.label} (${childName})`,
          quantity: '1',
          base_price_money: { amount: ci.pence, currency: 'GBP' },
          note: `trialpay:${email}|${encodeURIComponent(childName)}|${ci.match}`,
        });
      }
    }

    if (!lineItems.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No pay-now classes found in submission' }) };
    }

    const reference = `trialpay:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const res = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: reference,
        order: {
          location_id: locationId,
          reference_id: reference,
          line_items: lineItems,
        },
        checkout_options: {
          redirect_url: `${process.env.SITE_URL || 'https://www.championgymnastics.co.uk'}/index.html?paid=1#contact`,
          ask_for_shipping_address: false,
          merchant_support_email: contact.email,
        },
      }),
    });
    const result = await res.json();
    if (!res.ok) {
      const details = (result.errors || []).map(e => `${e.code}: ${e.detail || e.category}`).join('; ');
      throw new Error(`Square API ${res.status}${details ? ` - ${details}` : ''}`);
    }

    const url = result.payment_link?.url;
    if (!url) throw new Error('Square did not return a payment link URL');

    return { statusCode: 200, body: JSON.stringify({ url }) };
  } catch (err) {
    console.error('trial-checkout error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
