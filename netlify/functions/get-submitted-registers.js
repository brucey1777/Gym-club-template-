const { getStore } = require('@netlify/blobs');
const { validatePin } = require('./_coach-auth');

exports.handler = async (event) => {
  if (!['GET', 'DELETE'].includes(event.httpMethod)) {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  const store = getStore({
    name: 'registers',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });

  const key = (event.queryStringParameters || {}).key;

  // DELETE a specific register
  if (event.httpMethod === 'DELETE') {
    if (!key) return { statusCode: 400, body: 'Missing key' };
    await store.delete(key).catch(() => {});
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (key) {
    // Download a specific register as CSV
    const entry = await store.getWithMetadata(key).catch(() => null);
    if (!entry) return { statusCode: 404, body: 'Register not found' };
    const filename = `register_${key}.csv`;
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: entry.data,
    };
  }

  // List all saved registers, newest first
  const { blobs } = await store.list({ includeMeta: true }).catch(() => ({ blobs: [] }));
  const sorted = blobs.sort((a, b) => (b.key > a.key ? 1 : -1));
  const items = sorted.map(b => ({
    key: b.key,
    className: b.metadata?.className ?? b.key,
    date: b.metadata?.date ?? '',
    submittedAt: b.metadata?.submittedAt ?? '',
    count: b.metadata?.count ?? '?',
  }));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ registers: items }),
  };
};
