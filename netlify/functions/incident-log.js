const { validatePin } = require('./_coach-auth');
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  const incidentStore = getStore({
    name: 'incidents',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });

  try {
    if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }

      const { childName, className, description, severity, date, reportedBy,
              parentName, parentEmail, emergencyName, emergencyPhone } = body;
      if (!childName || !className || !description || !severity || !date || !reportedBy) {
        return { statusCode: 400, body: JSON.stringify({ error: 'childName, className, description, severity, date, reportedBy are required' }) };
      }

      const validSeverities = ['low', 'medium', 'high'];
      if (!validSeverities.includes(severity)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'severity must be low, medium, or high' }) };
      }

      const blobKey = `${date}_${Date.now()}`;
      await incidentStore.setJSON(blobKey, {
        childName,
        className,
        description,
        severity,
        date,
        reportedBy,
        parentName: parentName || '',
        parentEmail: parentEmail || '',
        emergencyName: emergencyName || '',
        emergencyPhone: emergencyPhone || '',
        loggedAt: new Date().toISOString(),
      });

      return { statusCode: 200, body: JSON.stringify({ ok: true, key: blobKey }) };

    } else if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      const dateFilter = params.date || null;
      const severityFilter = params.severity || null;

      const { blobs } = await incidentStore.list().catch(() => ({ blobs: [] }));

      const incidents = [];
      for (const blob of blobs) {
        try {
          const data = await incidentStore.get(blob.key, { type: 'json' });
          if (!data) continue;

          if (dateFilter && data.date !== dateFilter) continue;
          if (severityFilter && data.severity !== severityFilter) continue;

          incidents.push({ key: blob.key, ...data });
        } catch (err) {
          console.error('Error reading incident blob', blob.key, err.message);
        }
      }

      // Sort newest first by loggedAt
      incidents.sort((a, b) => new Date(b.loggedAt) - new Date(a.loggedAt));

      return { statusCode: 200, body: JSON.stringify({ incidents }) };

    } else if (event.httpMethod === 'DELETE') {
      const key = (event.queryStringParameters || {}).key;
      if (!key) return { statusCode: 400, body: JSON.stringify({ error: 'Missing key' }) };
      await incidentStore.delete(key).catch(() => {});
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };

    } else {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
  } catch (err) {
    console.error('incident-log error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
