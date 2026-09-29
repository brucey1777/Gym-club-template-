const { createClient } = require('@supabase/supabase-js');
const { getStore } = require('@netlify/blobs');

const ALLOWED_ORIGIN = 'https://www.championgymnastics.co.uk';

function corsHeaders(event) {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowed = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin',
  };
}

function json(statusCode, body, event = {}) {
  return {
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event) };
  }

  const action = (event.queryStringParameters || {}).action;

  // Public: return Supabase public config for browser-side auth (PIN never included)
  if (action === 'config') {
    return json(200, {
      url: process.env.SUPABASE_URL,
      anonKey: process.env.SUPABASE_ANON_KEY,
    }, event);
  }

  // Authenticated: return this parent's child registrations
  if (action === 'my-child') {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return json(401, { error: 'Not authenticated' }, event);

    // Verify JWT via Supabase service key
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY,
      { auth: { persistSession: false } }
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json(401, { error: 'Invalid or expired session' }, event);

    const email = user.email.toLowerCase();

    // Fetch all form submissions from Netlify Forms API
    const netlifyToken = process.env.NETLIFY_ACCESS_TOKEN;
    const siteId = process.env.NETLIFY_SITE_ID;

    const formsRes = await fetch(
      `https://api.netlify.com/api/v1/sites/${siteId}/forms`,
      { headers: { Authorization: `Bearer ${netlifyToken}` } }
    );
    if (!formsRes.ok) return json(500, { error: 'Could not fetch forms' }, event);
    const forms = await formsRes.json();

    const regForm = forms.find(f => f.name === 'registration');
    if (!regForm) return json(200, { registrations: [] }, event);

    const subRes = await fetch(
      `https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`,
      { headers: { Authorization: `Bearer ${netlifyToken}` } }
    );
    if (!subRes.ok) return json(500, { error: 'Could not fetch submissions' }, event);
    const submissions = await subRes.json();

    // Filter to this parent's email
    const matching = submissions.filter(s =>
      (s.data?.email || '').toLowerCase() === email
    );

    if (!matching.length) return json(200, { registrations: [] }, event);

    // Enrich with payment data from Netlify Blobs
    const store = getStore({ name: 'payments', siteID: siteId, token: netlifyToken });
    const enriched = await Promise.all(matching.map(async (s) => {
      try {
        const record = await store.get(`submission:${s.id}`, { type: 'json' });
        return { ...s, paid: !!record, paymentDetail: record };
      } catch {
        return { ...s, paid: false, paymentDetail: null };
      }
    }));

    return json(200, { registrations: enriched }, event);
  }

  // Public: email-only lookup — returns basic booking info, no auth required
  // Called by /parent-portal.html as GET ?action=email-lookup&email=...
  if (action === 'email-lookup') {
    const email = ((event.queryStringParameters || {}).email || '').toLowerCase().trim();
    if (!email || !email.includes('@')) return json(400, { error: 'Valid email required' }, event);

    const netlifyToken = process.env.NETLIFY_ACCESS_TOKEN;
    const siteId = process.env.NETLIFY_SITE_ID;

    try {
      const formsRes = await fetch(
        `https://api.netlify.com/api/v1/sites/${siteId}/forms`,
        { headers: { Authorization: `Bearer ${netlifyToken}` } }
      );
      const forms = await formsRes.json();
      const regForm = Array.isArray(forms) ? forms.find(f => f.name === 'registration') : null;
      if (!regForm) return json(200, { bookings: [] }, event);

      const subRes = await fetch(
        `https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`,
        { headers: { Authorization: `Bearer ${netlifyToken}` } }
      );
      const subs = await subRes.json();
      if (!Array.isArray(subs)) return json(200, { bookings: [] }, event);

      const matched = subs.filter(s => (s.data?.email || '').toLowerCase().trim() === email);

      const payStore = getStore({ name: 'payments', siteID: siteId, token: netlifyToken });
      const bookings = await Promise.all(matched.map(async s => {
        const payRecord = await payStore.get(`submission:${s.id}`, { type: 'json' }).catch(() => null);
        const cls = s.data?.class || '';
        return {
          childName: s.data?.child_name || '—',
          class: Array.isArray(cls) ? cls.join(', ') : cls,
          paid: !!payRecord,
          submittedAt: s.created_at || null,
        };
      }));

      return json(200, { bookings }, event);
    } catch (err) {
      console.error('email-lookup error:', err);
      return json(500, { error: 'Lookup failed' }, event);
    }
  }

  return json(404, { error: 'Unknown action' }, event);
};
