const { getStore } = require('@netlify/blobs');
const { validatePin } = require('./_coach-auth');

exports.handler = async (event) => {
  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  const store = getStore({
    name: 'settings',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });

  // GET — return all overrides
  if (event.httpMethod === 'GET') {
    const data = await store.get('registration-overrides', { type: 'json' }).catch(() => ({}));
    return { statusCode: 200, body: JSON.stringify({ overrides: data || {} }) };
  }

  // POST — save one override (body: { id, overrides })
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const { id, overrides } = body;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id' }) };

    // Merge per-id, not replace — a caller sending a partial override object
    // (e.g. just { class }) must not wipe out other fields already saved for
    // this submission (notes, a prior edit, an automated trial-conversion).
    const current = await store.get('registration-overrides', { type: 'json' }).catch(() => ({}));
    const updated = { ...(current || {}), [id]: { ...((current || {})[id] || {}), ...overrides } };
    await store.setJSON('registration-overrides', updated);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // DELETE — remove one override (query param: id)
  if (event.httpMethod === 'DELETE') {
    const id = (event.queryStringParameters || {}).id;
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing id' }) };

    const current = await store.get('registration-overrides', { type: 'json' }).catch(() => ({}));
    if (current) delete current[id];
    await store.setJSON('registration-overrides', current || {});
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: 'Method not allowed' };
};
