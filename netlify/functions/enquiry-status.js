const { validatePin } = require('./_coach-auth');
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (!['GET', 'DELETE'].includes(event.httpMethod)) {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const store = getStore({ name: 'enquiries', siteID: siteId, token });

  if (event.httpMethod === 'DELETE') {
    const key = (event.queryStringParameters || {}).key;
    if (!key) return { statusCode: 400, body: JSON.stringify({ error: 'Missing key' }) };
    await store.delete(key).catch(() => {});
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  try {
    const { blobs } = await store.list().catch(() => ({ blobs: [] }));

    const enquiries = [];
    for (const blob of blobs) {
      try {
        const data = await store.get(blob.key, { type: 'json' });
        if (!data) continue;
        enquiries.push({
          key: blob.key,
          name: data.name || '',
          email: data.email || '',
          message: data.message || '',
          receivedAt: data.receivedAt || null,
          replied: !!data.replied,
          repliedAt: data.repliedAt || null,
          replyText: data.replyText || null,
          draftReply: data.draftReply || null,
          draftGeneratedAt: data.draftGeneratedAt || null,
        });
      } catch (err) {
        console.error('Error reading enquiry blob', blob.key, err.message);
      }
    }

    enquiries.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

    const now = Date.now();
    const DELAY_MS = 2 * 60 * 60 * 1000;
    const total = enquiries.length;
    const replied = enquiries.filter(e => e.replied).length;
    const draftReady = enquiries.filter(e => !e.replied && e.draftReply).length;
    // "Stuck" now means no draft ever got generated (e.g. a Claude API
    // error) — a draft sitting there waiting for staff review is expected,
    // normal operation, not a failure.
    const stuck = enquiries.filter(e => !e.replied && !e.draftReply && (now - new Date(e.receivedAt).getTime()) > DELAY_MS).length;
    const pending = enquiries.filter(e => !e.replied && !e.draftReply && (now - new Date(e.receivedAt).getTime()) <= DELAY_MS).length;

    return {
      statusCode: 200,
      body: JSON.stringify({ total, replied, draftReady, stuck, pending, enquiries }),
    };
  } catch (err) {
    console.error('enquiry-status error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
