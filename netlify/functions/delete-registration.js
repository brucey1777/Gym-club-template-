const { validatePin } = require('./_coach-auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { submissionId } = body;
  if (!submissionId) {
    return { statusCode: 400, body: 'Missing submissionId' };
  }

  const token = process.env.NETLIFY_ACCESS_TOKEN;
  if (!token) {
    return { statusCode: 500, body: 'Missing NETLIFY_ACCESS_TOKEN' };
  }

  const res = await fetch(
    `https://api.netlify.com/api/v1/submissions/${submissionId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  );

  if (res.status === 204 || res.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const text = await res.text().catch(() => String(res.status));
  return { statusCode: res.status, body: JSON.stringify({ error: text }) };
};
