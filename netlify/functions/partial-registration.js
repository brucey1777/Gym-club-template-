const { getStore } = require('@netlify/blobs');
const { validatePin } = require('./_coach-auth');

exports.handler = async (event) => {
  const siteId = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  const store  = getStore({ name: 'partial-registrations', siteID: siteId, token });

  // POST — save or clear a partial registration (called by sendBeacon, no auth)
  if (event.httpMethod === 'POST') {
    try {
      const data = JSON.parse(event.body || '{}');
      if (!data.email) return { statusCode: 400, body: 'Missing email' };

      const key = 'partial:' + data.email.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');

      // ?clear=1 means the form was submitted successfully — remove the record
      if (event.queryStringParameters?.clear === '1') {
        await store.delete(key).catch(() => {});
        return { statusCode: 200, body: 'cleared' };
      }

      await store.setJSON(key, {
        ...data,
        key,
        savedAt: data.savedAt || new Date().toISOString(),
      });
      return { statusCode: 200, body: 'saved' };
    } catch (err) {
      console.error('partial-registration save error:', err.message);
      return { statusCode: 500, body: err.message };
    }
  }

  // GET — list partial registrations (coach-authenticated)
  if (event.httpMethod === 'GET') {
    const authPin = event.headers['x-coach-pin'];
    if (!validatePin(authPin)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
    }

    try {
      const { blobs } = await store.list({ prefix: 'partial:' }).catch(() => ({ blobs: [] }));
      const partials = [];
      for (const blob of blobs) {
        try {
          const data = await store.get(blob.key, { type: 'json' });
          if (data) partials.push(data);
        } catch {}
      }
      // Newest first
      partials.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
      return { statusCode: 200, body: JSON.stringify({ partials }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  // DELETE — remove a partial registration (coach-authenticated)
  if (event.httpMethod === 'DELETE') {
    const authPin = event.headers['x-coach-pin'];
    if (!validatePin(authPin)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
    }
    const key = (event.queryStringParameters || {}).key;
    if (!key) return { statusCode: 400, body: 'Missing key' };
    await store.delete(key).catch(() => {});
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: 'Method not allowed' };
};
