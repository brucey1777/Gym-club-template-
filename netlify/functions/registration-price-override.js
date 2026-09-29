const { validateDevPin } = require('./auth-dev-pin');
const { getStore } = require('@netlify/blobs');
const { getTermConfig } = require('./_term-config');

// Manual, staff-driven counterpart to _registration-pricing.js's automatic
// lock-in. New registrations lock their price in themselves at sign-up —
// this exists only for submissions that predate that (or any other case
// where staff need to correct/set a family's locked price by hand), so a
// Term Wizard price change doesn't silently apply to them before payment.

function settingsStore() {
  return getStore({ name: 'settings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_ACCESS_TOKEN });
}

exports.handler = async (event) => {
  const authPin = event.headers['x-dev-pin'];
  if (!validateDevPin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;

  try {
    if (event.httpMethod === 'GET') {
      const { classes: CLASS_INFO } = await getTermConfig();
      const sortedClasses = [...CLASS_INFO].sort((a, b) => b.match.length - a.match.length);

      const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/forms`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const forms = await formsRes.json();
      const regForm = Array.isArray(forms) ? forms.find(f => f.name === 'registration') : null;
      if (!regForm) return { statusCode: 200, headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ submissions: [] }) };

      const subRes = await fetch(`https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      let submissions = await subRes.json();
      if (!Array.isArray(submissions)) submissions = [];

      const payStore = getStore({ name: 'payments', siteID: siteId, token });
      const paidIds = new Set();
      try {
        const { blobs } = await payStore.list();
        blobs.forEach(b => { if (b.key.startsWith('submission:')) paidIds.add(b.key.replace('submission:', '')); });
      } catch (err) {
        console.error('registration-price-override: could not read payments:', err.message);
        return { statusCode: 503, body: JSON.stringify({ error: 'Payment verification unavailable' }) };
      }

      const overrides = await settingsStore().get('registration-overrides', { type: 'json' }).catch(() => ({})) || {};

      const results = submissions
        .filter(s => !paidIds.has(s.id))
        .map(s => {
          const data = s.data || {};
          const rawClass = data.class || '';
          const classStrs = Array.isArray(rawClass) ? rawClass : (rawClass ? [rawClass] : []);
          const classInfos = classStrs.map(cs => sortedClasses.find(c => cs.includes(c.match))).filter(Boolean);
          const existing = (overrides[s.id] && overrides[s.id]._originalPricing) || null;

          return {
            id: s.id,
            childName: data.child_name || '',
            parentName: data.parent_name || '',
            email: data.email || '',
            classes: classInfos.map(ci => ({
              match: ci.match,
              label: ci.label,
              livePence: ci.pence,
              lockedPence: existing && existing[ci.match] !== undefined ? existing[ci.match] : null,
            })),
          };
        })
        .filter(s => s.classes.length > 0);

      return { statusCode: 200, headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ submissions: results }) };
    }

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }
      const { submissionId, match, pence } = body;
      if (!submissionId || !match || typeof pence !== 'number' || pence < 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'submissionId, match, and a non-negative pence value are required' }) };
      }

      const store = settingsStore();
      const overrides = await store.get('registration-overrides', { type: 'json' }).catch(() => ({})) || {};
      const existing = overrides[submissionId] || {};
      const pricing = { ...(existing._originalPricing || {}), [match]: pence };
      overrides[submissionId] = { ...existing, _originalPricing: pricing };
      await store.setJSON('registration-overrides', overrides);

      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error('registration-price-override error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error: ' + (err.message || 'unknown') }) };
  }
};
