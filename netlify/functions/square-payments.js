const { validatePin } = require('./_coach-auth');
const { requireFeature } = require('./_require-feature');

const SQUARE_API_VERSION = '2026-05-20';

// Live Square Payments ledger for the staff Revenue tab — a raw
// transaction list straight from Square, separate from the class-by-class
// registration breakdown above it on the same page. That breakdown is
// derived from Netlify Forms registrations + our own payments store, so it
// can't show a refund, a manual/terminal sale, or catch a payment that
// somehow never got recorded against a submission — this can, because it
// asks Square directly.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  const blocked = requireFeature('payments');
  if (blocked) return blocked;

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!accessToken || !locationId) {
    return { statusCode: 200, body: JSON.stringify({ payments: [], error: 'Square is not configured (missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID)' }) };
  }

  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit) || 50, 100);
  const cursor = params.cursor || undefined;

  try {
    const url = new URL('https://connect.squareup.com/v2/payments');
    url.searchParams.set('location_id', locationId);
    url.searchParams.set('sort_order', 'DESC');
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_API_VERSION,
      },
    });
    const data = await res.json();
    if (!res.ok) {
      const details = (data.errors || []).map(e => `${e.code}: ${e.detail || e.category}`).join('; ');
      throw new Error(`Square API ${res.status}${details ? ` - ${details}` : ''}`);
    }

    const payments = (data.payments || []).map(p => {
      const card = p.card_details && p.card_details.card;
      const amountPence = p.amount_money ? p.amount_money.amount : 0;
      // Real fee Square actually charged for this payment (sums INITIAL +
      // any later ADJUSTMENT entries) — not an estimate from a flat rate,
      // which would be wrong for the fixed-25p portion on small trial
      // payments vs larger term payments.
      const feePence = (p.processing_fee || []).reduce((sum, f) => sum + (f.amount_money ? f.amount_money.amount : 0), 0);
      return {
        id: p.id,
        status: p.status,
        amountPence,
        feePence,
        netPence: amountPence - feePence,
        currency: p.amount_money ? p.amount_money.currency : 'GBP',
        createdAt: p.created_at,
        cardBrand: card ? card.card_brand : null,
        cardLast4: card ? card.last_4 : null,
        sourceType: p.source_type || null,
        receiptUrl: p.receipt_url || null,
        orderId: p.order_id || null,
        refunded: !!(p.refunded_money && p.refunded_money.amount > 0),
        refundedPence: p.refunded_money ? p.refunded_money.amount : 0,
      };
    });

    // Totals for the currently-loaded page only (not all-time) — completed
    // payments only, since a failed payment was never actually charged a fee.
    const completed = payments.filter(p => p.status === 'COMPLETED');
    const totals = {
      amountPence: completed.reduce((s, p) => s + p.amountPence, 0),
      feePence: completed.reduce((s, p) => s + p.feePence, 0),
      netPence: completed.reduce((s, p) => s + p.netPence, 0),
    };

    return {
      statusCode: 200,
      body: JSON.stringify({ payments, totals, cursor: data.cursor || null }),
    };
  } catch (err) {
    console.error('square-payments error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
