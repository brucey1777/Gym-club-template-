const { getStore } = require('@netlify/blobs');
const { identity } = require('../../club.config');
const nodemailer = require('nodemailer');
const { validatePin } = require('./_coach-auth');

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
  { match: 'Year 1 & 2',     label: 'Lunchtime Y1&2 (Wed 12–12:30)' },
  { match: 'Year 3',          label: 'Lunchtime Y3 (Wed 12:30–1)' },
  { match: 'Year 4',          label: 'After School Y4–6 (Wed 3:30–4:30)' },
];

exports.handler = async (event) => {
  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;

  // DELETE — remove a waiting-list entry (coach-authenticated)
  if (event.httpMethod === 'DELETE') {
    const authPin = event.headers['x-coach-pin'];
    if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
    const key = (event.queryStringParameters || {}).key;
    if (!key) return { statusCode: 400, body: JSON.stringify({ error: 'Missing key' }) };
    const wlStore = getStore({ name: 'waiting-list', siteID: siteId, token });
    await wlStore.delete(key).catch(() => {});
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // PATCH — edit a waiting-list entry's details, or move it onto a
  // different class (coach-authenticated). The blob's key keeps its
  // original class prefix — get-waiting-list.js groups entries by the
  // classMatch field in the stored data, not by parsing the key, so
  // moving a class here doesn't require renaming the blob.
  if (event.httpMethod === 'PATCH') {
    const authPin = event.headers['x-coach-pin'];
    if (!validatePin(authPin)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
    let patchBody;
    try { patchBody = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const { key, updates } = patchBody;
    if (!key || !updates) return { statusCode: 400, body: JSON.stringify({ error: 'Missing key or updates' }) };

    const wlStore = getStore({ name: 'waiting-list', siteID: siteId, token });
    const existing = await wlStore.get(key, { type: 'json' }).catch(() => null);
    if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Entry not found' }) };

    const merged = { ...existing };
    if (updates.childName !== undefined) merged.childName = updates.childName;
    if (updates.parentName !== undefined) merged.parentName = updates.parentName;
    if (updates.email !== undefined) merged.email = updates.email;
    if (updates.phone !== undefined) merged.phone = updates.phone;
    if (updates.yearGroup !== undefined) merged.yearGroup = updates.yearGroup;
    if (updates.classMatch !== undefined && updates.classMatch !== existing.classMatch) {
      const classInfo = CLASS_INFO.find(c => c.match === updates.classMatch);
      merged.classMatch = updates.classMatch;
      merged.classLabel = classInfo ? classInfo.label : updates.classMatch;
    }
    await wlStore.setJSON(key, merged);
    return { statusCode: 200, body: JSON.stringify({ ok: true, entry: merged }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Rate limit
  const rlStore = getStore({ name: 'rate-limits', siteID: siteId, token });
  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';
  const key = `waitlist:${ip}`;
  try {
    const existing = await rlStore.get(key, { type: 'json' }).catch(() => null);
    const now = Date.now();
    if (existing && existing.count >= 3 && (now - existing.first) < 3600000) {
      return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests' }) };
    }
    await rlStore.setJSON(key, { count: (existing?.count || 0) + 1, first: existing?.first || now });
  } catch (err) {
    console.error('Rate limit check failed:', err.message);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { childName, parentName, email, phone, classMatch, yearGroup } = body;
  if (!childName || !parentName || !email || !classMatch) {
    return { statusCode: 400, body: JSON.stringify({ error: 'childName, parentName, email, classMatch are required' }) };
  }
  // Catch an invalid email here, with a message the form can show, rather
  // than letting it reach nodemailer's sendMail() below — an address
  // without an "@" throws there and used to surface as a generic
  // "Something went wrong" 500, with no way for the parent to tell what
  // was actually wrong with what they'd typed.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a valid email address' }) };
  }

  const classInfo = CLASS_INFO.find(c => c.match === classMatch);
  const classLabel = classInfo ? classInfo.label : classMatch;

  try {
    const wlStore = getStore({ name: 'waiting-list', siteID: siteId, token });
    const now = Date.now();
    const blobKey = `${classMatch}_${now}`;

    // Count existing entries for this class to compute position
    const { blobs } = await wlStore.list({ prefix: classMatch }).catch(() => ({ blobs: [] }));
    const position = blobs.length + 1;

    await wlStore.setJSON(blobKey, {
      childName,
      parentName,
      email,
      phone: phone || '',
      classMatch,
      classLabel,
      yearGroup: yearGroup || '',
      addedAt: new Date().toISOString(),
    });

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });

    // The waiting-list entry above is already saved at this point — a
    // family should never see "Something went wrong" (and wonder if they
    // need to try again, risking a duplicate entry) just because a
    // confirmation email hiccupped. Emails are best-effort from here.
    try {
      // Confirmation to parent
      await transporter.sendMail({
        from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: `Waiting list confirmation – ${classLabel}`,
        html: `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;color:#333;padding:24px;max-width:600px;margin:0 auto;">
  <div style="background:#0d1b2a;padding:24px;border-radius:8px 8px 0 0;text-align:center;">
    <h1 style="margin:0;color:#fff;font-size:20px;">${identity.name}</h1>
  </div>
  <div style="background:#fffdf7;padding:28px;border-radius:0 0 8px 8px;">
    <p>Dear ${parentName},</p>
    <p>Thank you for registering <strong>${childName}</strong> on the waiting list for <strong>${classLabel}</strong>.</p>
    <p>You're on the waiting list and we'll contact you as soon as a space opens. Your position will be based on when you joined the list.</p>
    <p>If you have any questions, please don't hesitate to get in touch.</p>
    <p>Warm regards,<br>${identity.name}</p>
    <hr style="border:none;border-top:1px solid #e0d8c8;margin:24px 0;">
    <p style="color:#888;font-size:12px;margin:0;">
      <a href="mailto:${process.env.GMAIL_USER}" style="color:#0d1b2a;">${process.env.GMAIL_USER}</a>
    </p>
  </div>
</body></html>`,
      });

      // Notify coach
      await transporter.sendMail({
        from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
        to: process.env.GMAIL_USER,
        subject: `New waiting list entry – ${classLabel}`,
        html: `<!DOCTYPE html>
<html><body style="font-family:Arial,sans-serif;color:#333;padding:24px;">
  <h2 style="color:#0d1b2a;">New Waiting List Entry</h2>
  <table style="border-collapse:collapse;width:100%;max-width:500px;">
    <tr><td style="padding:8px;font-weight:bold;width:140px;">Child:</td><td style="padding:8px;">${childName}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Parent:</td><td style="padding:8px;">${parentName}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Email:</td><td style="padding:8px;">${email}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Phone:</td><td style="padding:8px;">${phone || '—'}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Class:</td><td style="padding:8px;">${classLabel}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Year group:</td><td style="padding:8px;">${yearGroup || '—'}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Position:</td><td style="padding:8px;">#${position}</td></tr>
  </table>
</body></html>`,
      });
    } catch (mailErr) {
      console.error('waiting-list confirmation email failed (entry still saved):', mailErr.message);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, position }) };
  } catch (err) {
    console.error('waiting-list error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
