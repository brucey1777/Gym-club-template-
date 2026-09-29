const { validatePin } = require('./_coach-auth');
const { getStore } = require('@netlify/blobs');
const { getTermConfig } = require('./_term-config');
const { enrolledPayableClasses, classesCoveredByPayment } = require('./_payment-coverage-lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  try {
    const currentConfig = await getTermConfig();
    const siteId = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_ACCESS_TOKEN;

    const store = getStore({ name: 'settings', siteID: siteId, token });
    const termHistory = await store.get('term-history', { type: 'json' }).catch(() => []) || [];

    // Determine which term to show
    const params = event.queryStringParameters || {};
    let afterISO, beforeISO, CLASS_INFO, termName, activeConfig;

    if (params.termIdx !== undefined) {
      const idx = parseInt(params.termIdx);
      const past = termHistory[idx];
      if (!past) return { statusCode: 404, body: JSON.stringify({ error: 'Term not found' }) };
      afterISO = past.termStartISO;
      beforeISO = past.termEndISO;
      CLASS_INFO = past.classes;
      termName = past.termName;
      activeConfig = past;
    } else {
      // Use end of last archived term as the lower bound so registrations
      // submitted before the term start date (e.g. early sign-ups) are included.
      // If no history exists, show all submissions.
      const lastArchived = termHistory.length ? termHistory[termHistory.length - 1] : null;
      afterISO = lastArchived ? lastArchived.termEndISO : null;
      beforeISO = null;
      CLASS_INFO = currentConfig.classes;
      termName = currentConfig.termName;
      activeConfig = currentConfig;
    }

    // The 18th August trial day was replaced with new September dates
    // (ffc3f62) — any families who registered under the old dates should
    // still show up here. Revenue report only; not restored anywhere else
    // (registration form, Term Wizard, etc). Only adds a visible row if
    // there's an actual registration matching it (classes with 0 enrolled
    // are filtered out client-side), so this is a no-op once none remain.
    const OLD_TRIALS = [
      { match: '18th Aug, 10:00', label: 'Trial – 18th Aug 10:00am (Rec–Y3)', pence: 800, schedule: 'Tuesday 18th August, 10:00–11:00am', trial: true },
      { match: '18th Aug, 11:00', label: 'Trial – 18th Aug 11:00am (Y4+)',    pence: 800, schedule: 'Tuesday 18th August, 11:00am–12:00pm', trial: true },
    ];
    const existingMatches = new Set(CLASS_INFO.map(c => c.match));
    CLASS_INFO = [...CLASS_INFO, ...OLD_TRIALS.filter(c => !existingMatches.has(c.match))];

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

    // Apply any staff-saved overrides (e.g. a trial registration converted
    // to an ongoing class once paid) so stats reflect the current, not the
    // original, class — same overrides the Register/Revenue UI applies.
    const overrides = await store.get('registration-overrides', { type: 'json' }).catch(() => ({})) || {};
    submissions.forEach(s => { if (overrides[s.id]) Object.assign(s.data, overrides[s.id]); });

    // Filter by term date range
    if (afterISO || beforeISO) {
      const after = afterISO ? new Date(afterISO) : null;
      const before = beforeISO ? new Date(beforeISO) : null;
      submissions = submissions.filter(s => {
        const created = new Date(s.created_at);
        if (after && created < after) return false;
        if (before && created >= before) return false;
        return true;
      });
    }

    // Load payment blobs
    const payStore = getStore({ name: 'payments', siteID: siteId, token });
    const { blobs: payBlobs } = await payStore.list({ prefix: 'submission:' }).catch(() => ({ blobs: [] }));

    // Map submissionId → amountPence actually received
    const paidAmounts = {};
    const payRecords = await Promise.all(payBlobs.map(blob =>
      payStore.get(blob.key, { type: 'json' }).catch(err => {
        console.error('Error reading payment blob', blob.key, err.message);
        return null;
      })
    ));
    payBlobs.forEach((blob, i) => {
      if (payRecords[i]) paidAmounts[blob.key.replace('submission:', '')] = payRecords[i].amountPence || 0;
    });
    // Which of each submission's enrolled classes their payment actually
    // covers — a submission only has one payment total, so a family who
    // paid for one of several classes must not show as "paid" against all
    // of them (see _payment-coverage-lib.js).
    const coveredByCid = {};
    submissions.forEach(sub => {
      coveredByCid[sub.id] = classesCoveredByPayment(enrolledPayableClasses(sub, CLASS_INFO, overrides, activeConfig), paidAmounts[sub.id] || 0);
    });

    // Check each individual class value separately so multi-class students
    // are counted in every class they're enrolled in, while tighter match
    // strings (e.g. 'Year 3 (Wed', 'Year 4–6') avoid false positives from
    // substrings like "Reception–Year 3" inside Minis or "Year 4+" in Juniors.
    function subMatchesClass(sub, matchStr) {
      const c = sub.data && sub.data.class;
      if (!c) return false;
      const list = Array.isArray(c) ? c : [String(c)];
      return list.some(v => v.includes(matchStr));
    }

    const classes = CLASS_INFO.map(cls => {
      const matched = submissions.filter(sub => subMatchesClass(sub, cls.match));

      const enrolled = matched.length;
      const paidSubs = matched.filter(s => coveredByCid[s.id] && coveredByCid[s.id].has(cls.match));
      const paid = paidSubs.length;
      const unpaid = enrolled - paid;
      const owedPence = enrolled * cls.pence;
      // Use this class's own price rather than the real Square amount on the
      // submission: a family paying for several classes in one order has the
      // FULL combined amount stored against that one submission ID, which
      // would otherwise get double-counted onto every class they're enrolled
      // in. Per-class nominal pricing also handles cash payments marked paid
      // manually (which store amountPence: 0) correctly, and keeps this
      // consistent with how outstandingPence is already computed below.
      const receivedPence = paid * cls.pence;
      const outstandingPence = unpaid * cls.pence;

      return {
        label: cls.label,
        match: cls.match,
        enrolled,
        paid,
        unpaid,
        owedPence,
        receivedPence,
        outstandingPence,
      };
    });

    const totals = classes.reduce((acc, cls) => ({
      enrolled: acc.enrolled + cls.enrolled,
      paid: acc.paid + cls.paid,
      unpaid: acc.unpaid + cls.unpaid,
      receivedPence: acc.receivedPence + cls.receivedPence,
      outstandingPence: acc.outstandingPence + cls.outstandingPence,
    }), { enrolled: 0, paid: 0, unpaid: 0, receivedPence: 0, outstandingPence: 0 });

    const termMeta = termHistory.map((t, i) => ({ idx: i, termName: t.termName, termStartISO: t.termStartISO, termEndISO: t.termEndISO }));
    return { statusCode: 200, body: JSON.stringify({ classes, totals, termName, termHistory: termMeta, currentTermName: currentConfig.termName }) };
  } catch (err) {
    console.error('revenue-stats error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
