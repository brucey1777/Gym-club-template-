const { getStore } = require('@netlify/blobs');
const { validatePin } = require('./_coach-auth');
const { getTermConfig } = require('./_term-config');
const { enrolledPayableClasses } = require('./_payment-coverage-lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { submissionId, status } = body;
  if (!submissionId) {
    return { statusCode: 400, body: 'Missing submissionId' };
  }
  // 'paid' (default) computes and records the full amount owed; 'partial'
  // records a staff-supplied amount less than that; 'unpaid' removes the
  // payment record entirely so the registration goes back to unpaid.
  const targetStatus = status || 'paid';
  if (!['paid', 'partial', 'unpaid'].includes(targetStatus)) {
    return { statusCode: 400, body: 'Invalid status' };
  }

  const siteId = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  if (!siteId || !token) {
    return { statusCode: 500, body: 'Missing env vars' };
  }

  try {
    const store = getStore({ name: 'payments', siteID: siteId, token });
    const settingsStore = getStore({ name: 'settings', siteID: siteId, token });

    if (targetStatus === 'unpaid') {
      await store.delete(`submission:${submissionId}`).catch(() => {});
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    if (targetStatus === 'partial') {
      const amountPence = Math.round(Number(body.amountPence));
      if (!Number.isFinite(amountPence) || amountPence <= 0) {
        return { statusCode: 400, body: 'Missing or invalid amountPence for a partial payment' };
      }
      await store.setJSON(`submission:${submissionId}`, {
        paymentId: `manual-${submissionId}`,
        amountPence,
        currency: 'GBP',
        buyerEmail: '',
        receiptUrl: null,
        createdAt: new Date().toISOString(),
        submissionId,
        manual: true,
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // "Mark as paid" means fully paid — record the actual amount owed for
    // this registration's enrolled classes, not 0. Writing 0 would make the
    // per-class coverage check (_payment-coverage-lib.js) think none of a
    // multi-class family's classes are covered, showing a false "PARTIAL"
    // badge even though staff just confirmed full payment.
    let amountPence = 0;
    try {
      const [termConfig, subRes, overrides] = await Promise.all([
        getTermConfig(),
        fetch(`https://api.netlify.com/api/v1/submissions/${submissionId}`, { headers: { Authorization: `Bearer ${token}` } }),
        settingsStore.get('registration-overrides', { type: 'json' }).catch(() => ({})),
      ]);
      if (subRes.ok) {
        const sub = await subRes.json();
        sub.data = sub.data || {};
        if (overrides && overrides[submissionId]) Object.assign(sub.data, overrides[submissionId]);
        const enrolled = enrolledPayableClasses(sub, termConfig.classes, overrides, termConfig);
        amountPence = enrolled.reduce((sum, c) => sum + c.pence, 0);
      }
    } catch (err) {
      console.error('mark-as-paid: could not compute owed amount, defaulting to 0:', err.message);
    }

    await store.setJSON(`submission:${submissionId}`, {
      paymentId: `manual-${submissionId}`,
      amountPence,
      currency: 'GBP',
      buyerEmail: '',
      receiptUrl: null,
      createdAt: new Date().toISOString(),
      submissionId,
      manual: true,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('mark-as-paid error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
