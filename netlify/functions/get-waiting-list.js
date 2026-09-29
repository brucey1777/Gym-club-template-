const { validatePin } = require('./_coach-auth');
const { getStore } = require('@netlify/blobs');

const CLASS_INFO = [
  { match: '11th Sep, 4:00',  label: 'Trial – 11th Sep 4:00pm (Rec–Y3)' },
  { match: '11th Sep, 5:00',  label: 'Trial – 11th Sep 5:00pm (Y4-6)' },
  { match: '18th Sep, 4:00',  label: 'Trial – 18th Sep 4:00pm (Rec–Y3)' },
  { match: '18th Sep, 5:00',  label: 'Trial – 18th Sep 5:00pm (Y4-6)' },
  { match: '25th Sep, 4:00',  label: 'Trial – 25th Sep 4:00pm (Rec–Y3)' },
  { match: '25th Sep, 5:00',  label: 'Trial – 25th Sep 5:00pm (Y4-6)' },
  { match: 'Minis',           label: 'Minis (Fri 4–5pm)' },
  { match: 'Juniors',         label: 'Juniors (Fri 5–6pm)' },
  { match: 'Seniors',         label: 'Seniors (Fri 6–7pm)' },
  { match: 'Seniors / Teens', label: 'Seniors/Teens (Fri 6–7pm)' }, // legacy — any waitlist entry from before the rename
  { match: 'Year 1 & 2',     label: 'Lunchtime Y1&2 (Wed 12–12:30)' },
  { match: 'Year 3',          label: 'Lunchtime Y3 (Wed 12:30–1)' },
  { match: 'Year 4',          label: 'After School Y4–6 (Wed 3:30–4:30)' },
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authPin = event.headers['x-coach-pin'];
  if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };

  const params = event.queryStringParameters || {};
  const classFilter = params.class || null;

  try {
    const wlStore = getStore({
      name: 'waiting-list',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_ACCESS_TOKEN,
    });

    const listOpts = classFilter ? { prefix: classFilter } : {};
    const { blobs } = await wlStore.list(listOpts).catch(() => ({ blobs: [] }));

    const entries = [];
    for (const blob of blobs) {
      try {
        const data = await wlStore.get(blob.key, { type: 'json' });
        if (!data) continue;
        entries.push({ key: blob.key, ...data });
      } catch (err) {
        console.error('Error reading waiting list blob', blob.key, err.message);
      }
    }

    // Sort oldest first (FIFO) by addedAt
    entries.sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt));

    // Group by class
    const byClass = {};
    for (const cls of CLASS_INFO) {
      byClass[cls.match] = [];
    }
    for (const entry of entries) {
      if (entry.classMatch && byClass[entry.classMatch] !== undefined) {
        byClass[entry.classMatch].push(entry);
      } else if (entry.classMatch) {
        byClass[entry.classMatch] = byClass[entry.classMatch] || [];
        byClass[entry.classMatch].push(entry);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ entries, byClass }) };
  } catch (err) {
    console.error('get-waiting-list error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
