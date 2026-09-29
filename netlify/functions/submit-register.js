const { getStore } = require('@netlify/blobs');
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

  const { className, date, rows } = body;
  if (!className || !date || !Array.isArray(rows)) {
    return { statusCode: 400, body: 'Missing className, date or rows' };
  }

  // Build CSV
  const headers = ['Date', 'Class', 'Present', 'Child Name', 'Year Group', 'School', 'Paid', 'Parent Name', 'Email', 'Phone', 'Medical / Allergies'];
  const escape = v => {
    const s = String(v ?? '').replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
  };
  const lines = [
    headers.join(','),
    ...rows.map(r => [
      date, className,
      r.present ? 'Yes' : 'No',
      r.childName, r.yearGroup, r.school,
      r.paid ? 'Yes' : 'No',
      r.parentName, r.email, r.phone, r.medical,
    ].map(escape).join(',')),
  ];
  const csv = lines.join('\r\n');

  // Key: YYYY-MM-DD_ClassName (safe for Blobs)
  const safeClass = className.replace(/[^a-zA-Z0-9 &–\-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
  const key = `${date}_${safeClass}`;

  const store = getStore({
    name: 'registers',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });

  await store.set(key, csv, {
    metadata: { className, date, submittedAt: new Date().toISOString(), count: rows.length },
  });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, key }),
  };
};
