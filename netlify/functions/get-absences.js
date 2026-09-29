const { validatePin } = require('./_coach-auth');
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  const params = event.queryStringParameters || {};
  const dateFilter = params.date || null;
  const classFilter = params.class || null;

  try {
    const absenceStore = getStore({
      name: 'absences',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });

    const { blobs } = await absenceStore.list().catch(() => ({ blobs: [] }));

    const absences = [];
    for (const blob of blobs) {
      try {
        const data = await absenceStore.get(blob.key, { type: 'json' });
        if (!data) continue;

        if (dateFilter && data.sessionDate !== dateFilter) continue;
        if (classFilter && !String(data.className).includes(classFilter)) continue;

        absences.push({ key: blob.key, ...data });
      } catch (err) {
        console.error('Error reading absence blob', blob.key, err.message);
      }
    }

    // Sort newest first by submittedAt
    absences.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    return { statusCode: 200, body: JSON.stringify({ absences }) };
  } catch (err) {
    console.error('get-absences error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
