const { validatePin } = require('./_coach-auth');
const { getStore } = require('@netlify/blobs');

const DEFAULT_SKILLS = [
  'Forward roll',
  'Backward roll',
  'Cartwheel',
  'Round-off',
  'Handstand',
  'Bridge',
  'Walkover (front)',
  'Walkover (back)',
  'Handspring (front)',
  'Handspring (back)',
  'Aerial',
  'Split',
  'Leap',
  'Jump combination',
];

exports.handler = async (event) => {
  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  const skillsStore = getStore({
    name: 'skills',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });

  try {
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      const submissionId = params.id;
      if (!submissionId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id query parameter required' }) };
      }

      const blobKey = `child:${submissionId}`;
      const skills = await skillsStore.get(blobKey, { type: 'json' }).catch(() => null) || {};

      return { statusCode: 200, body: JSON.stringify({ skills, submissionId, DEFAULT_SKILLS }) };

    } else if (event.httpMethod === 'POST') {
      let body;
      try {
        body = JSON.parse(event.body || '{}');
      } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }

      const { submissionId, skills } = body;
      if (!submissionId || typeof skills !== 'object') {
        return { statusCode: 400, body: JSON.stringify({ error: 'submissionId and skills object required' }) };
      }

      const blobKey = `child:${submissionId}`;
      await skillsStore.setJSON(blobKey, skills);

      return { statusCode: 200, body: JSON.stringify({ ok: true }) };

    } else {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
  } catch (err) {
    console.error('skills error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
