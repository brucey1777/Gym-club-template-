const { getStore } = require('@netlify/blobs');
const { identity } = require('../../club.config');
const { requireFeature } = require('./_require-feature');
const nodemailer = require('nodemailer');
const { getTermConfig } = require('./_term-config');
const { createPaymentLink, emailHtml } = require('./_trial-followup-lib');

// Runs hourly via the schedule in netlify.toml.
//
// Part 1: for each trial-class register submitted by staff, waits 2h then
// emails every child marked Present (and not already followed up) a
// payment link to join the ongoing class. Where we can match the attendee
// back to their original trial registration (by email + trial class), the
// payment link is tagged with that real submission ID so it lands as a
// normal payment against their existing record instead of an untracked
// one-off.
//
// Part 2: for anyone we've already emailed and matched to a registration,
// checks whether they've now paid — and if so, overwrites their
// registration's `class` to the ongoing class they paid for (via the same
// registration-overrides store the Register/Revenue tabs already read),
// so they show up as a proper Minis/Juniors registrant instead of a
// leftover trial entry once they convert.
//
// For a manual test send, use trial-followup-test.js instead — Netlify
// blocks direct HTTP invocation of scheduled functions, so this one can
// only ever run on its cron schedule.
const FOLLOWUP_DELAY_MS = 2 * 60 * 60 * 1000;

// Which ongoing class (by `match` in term-config) each trial slot feeds into.
// Adjust here if trial slots or their target classes change.
const TRIAL_TO_TERM_CLASS = {
  '11th Sep, 4:00': 'Minis',
  '11th Sep, 5:00': 'Juniors',
  '18th Sep, 4:00': 'Minis',
  '18th Sep, 5:00': 'Juniors',
  '25th Sep, 4:00': 'Minis',
  '25th Sep, 5:00': 'Juniors',
  '18th Sep, 6:00': 'Seniors',
};

// Minimal CSV parser matching the escape() used in submit-register.js
// (quotes fields containing commas/quotes/newlines, doubles inner quotes).
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

function findMatchingSubmission(submissions, email, trialMatch) {
  const emailKey = email.toLowerCase().trim();
  return submissions.find(s => {
    const subEmail = (s.data?.email || '').toLowerCase().trim();
    if (subEmail !== emailKey) return false;
    const cls = s.data?.class;
    const classStr = Array.isArray(cls) ? cls.join(' ') : String(cls || '');
    return classStr.includes(trialMatch);
  }) || null;
}

async function applyClassOverride(settingsStore, submissionId, newClass) {
  const current = await settingsStore.get('registration-overrides', { type: 'json', consistency: 'strong' }).catch(() => ({})) || {};
  const existing = current[submissionId] || {};
  current[submissionId] = { ...existing, class: newClass };
  await settingsStore.setJSON('registration-overrides', current);
}

exports.handler = async () => {
  const blocked = requireFeature('payments');
  if (blocked) return blocked;

  // Disabled until further notice — return without sending any follow-up
  // emails or running the payment/conversion check. Remove this block to
  // re-enable.
  return { statusCode: 200, body: 'trial-followup: disabled until further notice.' };

  // eslint-disable-next-line no-unreachable
  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;

  const registerStore = getStore({ name: 'registers', siteID: siteId, token });
  const followupStore = getStore({ name: 'trial-followups', siteID: siteId, token });
  const paymentStore = getStore({ name: 'payments', siteID: siteId, token });
  const settingsStore = getStore({ name: 'settings', siteID: siteId, token });

  const termConfig = await getTermConfig();
  const CLASS_INFO = termConfig.classes;
  const termName = termConfig.termName;

  const { blobs } = await registerStore.list({ includeMeta: true }).catch(() => ({ blobs: [] }));
  const now = Date.now();

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  let registrations = null; // fetched lazily, once, only if a trial register is actually due

  let sent = 0;
  let converted = 0;

  for (const blob of blobs) {
    const className = blob.metadata?.className || '';
    const submittedAt = blob.metadata?.submittedAt;
    if (!submittedAt) continue;

    const trialMatch = Object.keys(TRIAL_TO_TERM_CLASS).find(m => className.includes(m));
    if (!trialMatch) continue;

    const targetClass = CLASS_INFO.find(c => c.match === TRIAL_TO_TERM_CLASS[trialMatch]);
    if (!targetClass || !(targetClass.pence > 0)) continue;

    const totalStr = `£${(targetClass.pence / 100).toFixed(2)}`;

    const record = (await followupStore.get(blob.key, { type: 'json' }).catch(() => null)) || { sentTo: [], details: {} };
    if (!record.details) record.details = {};

    // ── Part 2: check payment + convert class for anyone already emailed ──
    for (const emailKey of Object.keys(record.details)) {
      const detail = record.details[emailKey];
      if (!detail.submissionId || detail.converted) continue;
      const payment = await paymentStore.get(`submission:${detail.submissionId}`, { type: 'json', consistency: 'strong' }).catch(() => null);
      if (!payment) continue;
      try {
        await applyClassOverride(settingsStore, detail.submissionId, detail.targetClassMatch);
        detail.converted = true;
        await followupStore.setJSON(blob.key, record);
        converted++;
        console.log('trial-followup: converted', detail.submissionId, 'to', detail.targetClassMatch);
      } catch (err) {
        console.error('trial-followup: override error for', detail.submissionId, err.message);
      }
    }

    // ── Part 1: send follow-up emails for newly-eligible attendees ────────
    const age = now - new Date(submittedAt).getTime();
    if (age < FOLLOWUP_DELAY_MS) continue;

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
      if (record.sentTo.includes(emailKey)) continue;

      // Try to match this attendee back to their original trial registration,
      // so the payment (and later, the class conversion) links to it.
      if (registrations === null) {
        registrations = await fetchRegistrationSubmissions(siteId, token).catch(err => {
          console.error('trial-followup: could not fetch registrations', err.message);
          return [];
        });
      }
      const matchedSub = findMatchingSubmission(registrations, email, trialMatch);

      const idKey = `${blob.key}:${emailKey}`;
      let paymentUrl;
      try {
        paymentUrl = await createPaymentLink({
          targetClass, termName, childName,
          idempotencyKey: matchedSub ? `cgy-trial-convert-${matchedSub.id}` : `cgy-trial-followup-${idKey}`,
          referenceId: matchedSub ? matchedSub.id : `trial-followup:${idKey}`,
        });
      } catch (err) {
        console.error('trial-followup: Square error for', emailKey, err.message);
        continue;
      }

      try {
        await transporter.sendMail({
          from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
          to: email,
          subject: `${childName ? childName + ', ready' : 'Ready'} to join us properly? 🤸 — ${identity.name}`,
          html: emailHtml({ parentName, childName, targetClass, termName, totalStr, paymentUrl }),
        });
        record.sentTo.push(emailKey);
        record.details[emailKey] = {
          submissionId: matchedSub ? matchedSub.id : null,
          targetClassMatch: targetClass.match,
          converted: false,
        };
        await followupStore.setJSON(blob.key, record);
        sent++;
        console.log('trial-followup: sent to', emailKey, 'for', blob.key, matchedSub ? `(linked to ${matchedSub.id})` : '(no matching registration found)');
      } catch (err) {
        console.error('trial-followup: email error for', emailKey, err.message);
      }
    }
  }

  return { statusCode: 200, body: `Done. Sent ${sent}, converted ${converted}.` };
};
