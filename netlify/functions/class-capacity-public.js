// netlify/functions/class-capacity-public.js
// Public (no auth) endpoint returning class capacities and current enrollment counts.
// Cached for 5 minutes via Cache-Control header.

const { getStore } = require('@netlify/blobs');
const { getTermConfig } = require('./_term-config');
const { enrolledPayableClasses, classesCoveredByPayment } = require('./_payment-coverage-lib');
const { buildProratedMap } = require('./_prorated-pricing');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;

  const initialConfig = await getTermConfig();
  const { classes: CLASS_INFO } = initialConfig;

  try {
    // Load capacities from blob store (set by coach via coach portal)
    const store = getStore({ name: 'settings', siteID: siteId, token });
    const capacities = await store.get('class-capacities', { type: 'json' }).catch(() => ({}));

    // Count enrollment from Netlify Forms submissions
    const formsRes = await fetch(
      `https://api.netlify.com/api/v1/sites/${siteId}/forms`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const forms = await formsRes.json();
    const regForm = Array.isArray(forms) ? forms.find(f => f.name === 'registration') : null;

    const enrolled = {};
    CLASS_INFO.forEach(c => { enrolled[c.match] = 0; });

    if (regForm) {
      const [subRes, payStore] = await Promise.all([
        fetch(`https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`, { headers: { Authorization: `Bearer ${token}` } }),
        getStore({ name: 'payments', siteID: siteId, token }),
      ]);
      const subs = await subRes.json();

      // Paid amounts (not just presence) — a submission only has one
      // payment total even when enrolled in several payable classes.
      const paidAmounts = {};
      try {
        const { blobs } = await payStore.list({ prefix: 'submission:' });
        const records = await Promise.all(blobs.map(b => payStore.get(b.key, { type: 'json' }).catch(() => null)));
        blobs.forEach((b, i) => {
          if (records[i]) paidAmounts[b.key.replace('submission:', '')] = records[i].amountPence || 0;
        });
      } catch {}

      if (Array.isArray(subs)) {
        // Apply overrides so a converted/edited registration (e.g. trial ->
        // ongoing class) counts against its current class, not its original
        // one — matches capacity-warning.js / waitlist-unpaid.js.
        const overrides = await store.get('registration-overrides', { type: 'json', consistency: 'strong' }).catch(() => ({})) || {};
        subs.forEach(s => { if (overrides[s.id]) Object.assign(s.data, overrides[s.id]); });

        subs.forEach(s => {
          const covered = classesCoveredByPayment(enrolledPayableClasses(s, CLASS_INFO, overrides, initialConfig), paidAmounts[s.id] || 0);
          covered.forEach(match => { enrolled[match] = (enrolled[match] || 0) + 1; });
        });
      }
    }

    // Compute pro-rated prices per class
    const config = initialConfig;
    const prorated = buildProratedMap(config, CLASS_INFO);

    // Raw, un-prorated current price per class (source of truth is
    // getTermConfig(), which is exactly what the Term Wizard writes to) —
    // `prorated` above only covers non-trial, non-zero, weekday-schedulable
    // classes, so trial prices and edge cases would otherwise never reach
    // the site's static pages after a Term Wizard price change.
    const pricing = {};
    CLASS_INFO.forEach(c => { pricing[c.match] = c.pence; });

    // Once a trial's date has passed, or it's explicitly flagged `full`,
    // drop it from the sign-up form — nobody should be able to register for
    // a trial session that's already happened or has no space left. Only
    // affects what the registration page offers; existing submissions for
    // that trial (and its `match` key for pricing/reporting) are untouched
    // everywhere else, since this filters `classes` only, not CLASS_INFO
    // itself.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const liveClassInfo = CLASS_INFO.filter(c => {
      if (c.full) return false;
      if (!c.trial || !c.trialDateISO) return true;
      return new Date(c.trialDateISO + 'T00:00:00') >= today;
    });

    // Full class list (group/value/label/meta/price/trial/match) so the
    // registration page can build its class checkboxes from CLASS_INFO
    // (defined in _term-config.js) instead of a separate hardcoded array.
    const classes = liveClassInfo.map(c => ({
      match: c.match, value: c.value || c.label, label: c.label,
      group: c.group || 'Classes', meta: c.meta || c.schedule || '',
      schedule: c.schedule || '', price: c.pence, trial: !!c.trial,
      // Classes that must be paid immediately at registration (currently
      // trials and private lessons) instead of via the usual follow-up
      // email payment link — see submitAll()'s trialChildren filter.
      payNow: !!c.payNow,
      // Visible but not yet bookable — the registration page shows it
      // disabled with "Registration coming soon" instead of a price.
      comingSoon: !!c.comingSoon,
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // Short cache so a Term Wizard price change reaches visitors quickly.
        'Cache-Control': 'public, max-age=30',
      },
      body: JSON.stringify({ capacities: capacities || {}, enrolled, prorated, pricing, classes }),
    };
  } catch (err) {
    // Fail gracefully — return empty data so the UI doesn't break
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify({ capacities: {}, enrolled: {} }),
    };
  }
};
