const { getStore } = require('@netlify/blobs');
const { validatePin } = require('./_coach-auth');
const { getTermConfig } = require('./_term-config');
const { enrolledPayableClasses } = require('./_payment-coverage-lib');

// One-off (repeatable) fix for a bug in the old mark-as-paid.js: before it
// was fixed to record the real amount owed, every manual "Mark as paid"
// click wrote amountPence: 0. That went unnoticed because a binary "does a
// payment record exist" check always treated it as fully paid — but the
// per-class coverage logic added since (Chase Unpaid, reminder emails,
// capacity warnings, the register's own PARTIAL badge, revenue) all compare
// the actual amount against what's owed, so these stale £0 records now look
// unpaid and trigger false reminders for families who genuinely paid.
//
// Scans every manual payment record, recomputes the amount owed for that
// registration's currently-enrolled classes (respecting price-locking and
// any class-conversion overrides, exactly like mark-as-paid.js does), and
// corrects any that are wrong. Safe to re-run — already-correct records are
// left untouched.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  if (!siteId || !token) {
    return { statusCode: 500, body: 'Missing env vars' };
  }

  try {
    const payStore = getStore({ name: 'payments', siteID: siteId, token });
    const settingsStore = getStore({ name: 'settings', siteID: siteId, token });

    const [termConfig, overrides, formsRes] = await Promise.all([
      getTermConfig(),
      settingsStore.get('registration-overrides', { type: 'json' }).catch(() => ({})).then(v => v || {}),
      fetch(`https://api.netlify.com/api/v1/sites/${siteId}/forms`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    const CLASS_INFO = termConfig.classes;

    const forms = await formsRes.json();
    const regForm = Array.isArray(forms) ? forms.find(f => f.name === 'registration') : null;
    let submissions = [];
    if (regForm) {
      const subRes = await fetch(`https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      submissions = await subRes.json();
      if (!Array.isArray(submissions)) submissions = [];
    }
    const byId = {};
    submissions.forEach(s => { byId[s.id] = s; });

    const { blobs } = await payStore.list({ prefix: 'submission:' });

    const fixed = [];
    const skipped = [];

    for (const blob of blobs) {
      const record = await payStore.get(blob.key, { type: 'json' }).catch(() => null);
      if (!record || !record.manual) continue;
      if ((record.amountPence || 0) > 0) continue; // already has a real amount — leave it alone

      const submissionId = blob.key.replace('submission:', '');
      const sub = byId[submissionId];
      if (!sub) { skipped.push({ submissionId, reason: 'registration not found' }); continue; }

      sub.data = sub.data || {};
      if (overrides[submissionId]) Object.assign(sub.data, overrides[submissionId]);

      const enrolled = enrolledPayableClasses(sub, CLASS_INFO, overrides, termConfig);
      const amountPence = enrolled.reduce((sum, c) => sum + c.pence, 0);
      const childName = sub.data.child_name || submissionId;

      if (amountPence <= 0) {
        skipped.push({ submissionId, childName, reason: 'no payable classes found — left as £0, check manually' });
        continue;
      }

      await payStore.setJSON(blob.key, { ...record, amountPence });
      fixed.push({ submissionId, childName, amountPence });
    }

    return { statusCode: 200, body: JSON.stringify({ scanned: blobs.length, fixed, skipped }) };
  } catch (err) {
    console.error('backfill-manual-payments error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
