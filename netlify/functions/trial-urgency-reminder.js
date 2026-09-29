const { getStore } = require('@netlify/blobs');
const { identity } = require('../../club.config');
const nodemailer = require('nodemailer');

// Runs daily via the schedule in netlify.toml. Second-touch nudge for trial
// attendees who got the initial trial-followup.js email but still haven't
// signed up for a longer-term (non-trial) place two weeks on. Different
// angle on purpose — urgency messaging pointing them to the members page to
// sign themselves up, rather than another payment link landing in their
// inbox.
//
// "Signed up" is checked directly against paid registrations (any
// non-trial class, any submission, matched by email) rather than trusting
// trial-followup.js's own `converted` flag — that flag only tracks
// conversions that went through its own payment-link flow, so it'd miss a
// family who paid via the ordinary registration form (e.g. the site's
// multi-child sign-up wizard) instead.
const URGENCY_DELAY_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks after the trial register was submitted

// Minimal CSV parser matching the escape() used in submit-register.js.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

async function fetchRegistrationSubmissions(siteId, token) {
  const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/forms`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const forms = await formsRes.json();
  const regForm = Array.isArray(forms) ? forms.find(f => f.name === 'registration') : null;
  if (!regForm) return [];

  const subRes = await fetch(`https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const submissions = await subRes.json();
  return Array.isArray(submissions) ? submissions : [];
}

// True if this email has any PAID registration for a non-trial class —
// i.e. they've actually secured a longer-term place, regardless of which
// flow (trial-followup payment link, or signing up fresh) got them there.
function hasSignedUpForLongerTerm(email, submissions, paidIds) {
  const emailKey = email.toLowerCase().trim();
  return submissions.some(s => {
    const subEmail = (s.data?.email || '').toLowerCase().trim();
    if (subEmail !== emailKey) return false;
    if (!paidIds.has(String(s.id))) return false;
    const cls = s.data?.class;
    const list = Array.isArray(cls) ? cls : [String(cls || '')];
    return list.some(v => v && !v.startsWith('Trial'));
  });
}

function emailHtml({ parentName, childName, siteUrl }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1A2B5E">
    <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
      <img src="${siteUrl}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto 4px;width:160px;height:auto" />
    </div>
    <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
      <p>Hi ${parentName || 'there'},</p>
      <p>We loved having <strong>${childName || 'your child'}</strong> try a session with us! Spaces are filling up fast for this term, and we'd hate for ${childName || 'them'} to miss out on a place.</p>
      <p>You can sign up any time from our members page, no need to wait for another email from us.</p>
      <div style="text-align:center;margin:22px 0">
        <a href="${siteUrl}/members.html" style="background:#F5A623;color:#111C3E;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 30px;border-radius:50px;display:inline-block">Sign Up Now →</a>
      </div>
      <p style="font-size:13px;color:#7A7A8A;text-align:center;margin-top:-10px">${siteUrl}/members.html</p>
      <p style="margin-top:24px">See you on the mat soon! 🤸<br><strong>${identity.name}</strong></p>
    </div>
  </div>`;
}

exports.handler = async () => {
  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const siteUrl = process.env.SITE_URL || 'https://www.championgymnastics.co.uk';

  const registerStore = getStore({ name: 'registers', siteID: siteId, token });
  const followupStore = getStore({ name: 'trial-followups', siteID: siteId, token });
  const payStore = getStore({ name: 'payments', siteID: siteId, token });

  const { blobs } = await registerStore.list({ includeMeta: true }).catch(() => ({ blobs: [] }));
  const now = Date.now();

  // Only fetched if at least one register is actually due, and only once.
  let submissions = null;
  let paidIds = null;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  let sent = 0;

  for (const blob of blobs) {
    const className = blob.metadata?.className || '';
    const submittedAt = blob.metadata?.submittedAt;
    if (!submittedAt || !/trial/i.test(className)) continue;

    const age = now - new Date(submittedAt).getTime();
    if (age < URGENCY_DELAY_MS) continue;

    // Only registers trial-followup.js has actually processed (sentTo
    // populated) have anyone eligible — everyone else hasn't even had
    // their first follow-up yet.
    const record = await followupStore.get(blob.key, { type: 'json' }).catch(() => null);
    if (!record || !record.sentTo || !record.sentTo.length) continue;
    if (!record.details) record.details = {};

    const csv = await registerStore.get(blob.key).catch(() => null);
    if (!csv) continue;

    const rows = parseCsv(csv);
    const dataRows = rows.slice(1); // drop header
    // Column order from submit-register.js: Date, Class, Present, Child Name, Year Group, School, Paid, Parent Name, Email, Phone, Medical

    for (const cols of dataRows) {
      const present = cols[2];
      const childName = cols[3];
      const parentName = cols[7];
      const email = (cols[8] || '').trim();
      if (present !== 'Yes' || !email) continue;

      const emailKey = email.toLowerCase();
      if (!record.sentTo.includes(emailKey)) continue; // never got the first follow-up
      const detail = record.details[emailKey] || {};
      if (detail.urgencySent) continue; // already nudged once

      if (submissions === null) {
        [submissions, paidIds] = await Promise.all([
          fetchRegistrationSubmissions(siteId, token).catch(err => {
            console.error('trial-urgency-reminder: could not fetch registrations', err.message);
            return [];
          }),
          payStore.list({ prefix: 'submission:' })
            .then(({ blobs }) => new Set(blobs.map(b => b.key.replace('submission:', ''))))
            .catch(() => new Set()),
        ]);
      }

      if (hasSignedUpForLongerTerm(email, submissions, paidIds)) continue; // already secured a place

      try {
        await transporter.sendMail({
          from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
          to: email,
          subject: `Spaces filling up fast${childName ? ` — don't miss out, ${childName}!` : ' — don\'t miss out!'} 🤸`,
          html: emailHtml({ parentName, childName, siteUrl }),
        });
        detail.urgencySent = true;
        detail.urgencySentAt = new Date().toISOString();
        record.details[emailKey] = detail;
        await followupStore.setJSON(blob.key, record);
        sent++;
        console.log('trial-urgency-reminder: sent to', emailKey, 'for', blob.key);
      } catch (err) {
        console.error('trial-urgency-reminder: email error for', emailKey, err.message);
      }
    }
  }

  return { statusCode: 200, body: `Done. Sent ${sent}.` };
};
