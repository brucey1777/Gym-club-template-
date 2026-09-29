const { validatePin } = require('./_coach-auth');
const { getStore } = require('@netlify/blobs');
const { getTermConfig } = require('./_term-config');
const { enrolledPayableClasses, classesCoveredByPayment } = require('./_payment-coverage-lib');

exports.handler = async (event) => {
  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const settingsStore = getStore({ name: 'settings', siteID: siteId, token });

  const termConfig = await getTermConfig();
  const { classes: CLASS_INFO } = termConfig;

  try {
    if (event.httpMethod === 'GET') {
      const capacities = await settingsStore.get('class-capacities', { type: 'json' }).catch(() => null) || {};

      const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/forms`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const forms = await formsRes.json();
      const regForm = forms.find(f => f.name === 'registration');

      let submissions = [];
      if (regForm) {
        const subRes = await fetch(`https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        submissions = await subRes.json();
      }

      // Only count paid registrations towards capacity. A submission only
      // has one payment total even when enrolled in several payable
      // classes, so amounts (not just presence of a payment) are needed to
      // tell which of a multi-class family's classes are actually covered.
      const payStore = getStore({ name: 'payments', siteID: siteId, token });
      const paidAmounts = {};
      try {
        const { blobs } = await payStore.list({ prefix: 'submission:' });
        const records = await Promise.all(blobs.map(b => payStore.get(b.key, { type: 'json' }).catch(() => null)));
        blobs.forEach((b, i) => {
          if (records[i]) paidAmounts[b.key.replace('submission:', '')] = records[i].amountPence || 0;
        });
      } catch {}

      // Apply overrides so a converted/edited registration (e.g. trial ->
      // ongoing class) counts against its current class, not its original
      // one — matches capacity-warning.js / waitlist-unpaid.js.
      const overrides = await settingsStore.get('registration-overrides', { type: 'json', consistency: 'strong' }).catch(() => ({})) || {};
      submissions.forEach(s => { if (overrides[s.id]) Object.assign(s.data, overrides[s.id]); });

      const enrolled = {};
      CLASS_INFO.forEach(c => { enrolled[c.match] = 0; });
      submissions.forEach(sub => {
        const covered = classesCoveredByPayment(enrolledPayableClasses(sub, CLASS_INFO, overrides, termConfig), paidAmounts[sub.id] || 0);
        covered.forEach(match => { if (match in enrolled) enrolled[match]++; });
      });

      return { statusCode: 200, body: JSON.stringify({ capacities, enrolled }) };

    } else if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }

      const { capacities } = body;
      if (!capacities || typeof capacities !== 'object') {
        return { statusCode: 400, body: JSON.stringify({ error: 'capacities object required' }) };
      }

      await settingsStore.setJSON('class-capacities', capacities);

      return { statusCode: 200, body: JSON.stringify({ ok: true, capacities }) };

    } else {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
  } catch (err) {
    console.error('class-capacity error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
