const { getStore } = require('@netlify/blobs');
const { validatePin } = require('./_coach-auth');

exports.handler = async (event) => {
  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  const siteId = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;

  if (!token || !siteId) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'NETLIFY_ACCESS_TOKEN or NETLIFY_SITE_ID not set' }),
    };
  }

  try {
    // ── Fetch Netlify Form submissions ──────────────────────────────────────────
    const formsRes = await fetch(
      `https://api.netlify.com/api/v1/sites/${siteId}/forms`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!formsRes.ok) {
      const errBody = await formsRes.text();
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Netlify API error ${formsRes.status}: ${errBody}` }),
      };
    }

    const forms = await formsRes.json();

    if (!Array.isArray(forms)) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `Unexpected forms response: ${JSON.stringify(forms)}` }),
      };
    }

    const regForm = forms.find(f => f.name === 'registration');

    if (!regForm) {
      return {
        statusCode: 200,
        body: JSON.stringify({ submissions: [], message: 'No registration form found yet' }),
      };
    }

    const subRes = await fetch(
      `https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const submissions = await subRes.json();

    // ── Fetch payment records from Netlify Blobs ────────────────────────────────
    // Match by submission ID only — email fallback is too loose (multiple
    // children from the same family would all appear paid if one has paid).
    const bySubmission = {};  // submissionId → record

    try {
      const store = getStore({ name: 'payments', siteID: siteId, token });
      const { blobs } = await store.list();
      const submissionBlobs = blobs.filter(b => b.key.startsWith('submission:'));

      // Fetch all payment records in parallel — sequentially awaiting each
      // one here used to take longer than the 60s function limit once the
      // payments store grew past a couple hundred entries.
      const records = await Promise.all(
        submissionBlobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
      );
      submissionBlobs.forEach((b, i) => {
        if (records[i]) bySubmission[b.key.replace('submission:', '')] = records[i];
      });
    } catch (blobErr) {
      console.warn('Blobs unavailable:', blobErr.message);
    }

    // Deduplicate by ID in case the Netlify API returns a submission twice
    const seen = new Set();
    const unique = Array.isArray(submissions)
      ? submissions.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; })
      : [];

    // ── Merge payment status into submissions ───────────────────────────────────
    const enriched = unique.map(s => {
      const paymentRecord = bySubmission[s.id] || null;
      return {
        ...s,
        paid: !!paymentRecord,
        paymentDetail: paymentRecord,
      };
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ submissions: enriched }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
