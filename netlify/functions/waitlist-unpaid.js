const { getStore } = require('@netlify/blobs');
const { identity, contact } = require('../../club.config');
const nodemailer = require('nodemailer');
const { getTermConfig } = require('./_term-config');
const { enrolledPayableClasses, classesCoveredByPayment, isClassCovered } = require('./_payment-coverage-lib');

// Runs daily via the schedule in netlify.toml. A registration only reserves
// a place informally — paid registrations always take priority. If a class
// has reached its set capacity purely from *paid* registrations, any
// still-unpaid registrant in that class no longer has a place to pay into.
// Move them onto the waiting list and let them know, instead of leaving
// them believing they still have a spot.
//
// Maps each term-config `match` string to the short class key used by
// waiting-list.js / waiting-list.html (which predate term-config and use
// their own slightly different keys).
const CLASS_KEY_MAP = {
  'Minis': 'Minis',
  'Juniors': 'Juniors',
  'Seniors': 'Seniors',
  'Year 1 & 2 (Wed': 'Year 1 & 2',
  'Year 3 (Wed': 'Year 3',
  'Year 4–6': 'Year 4',
};

function emailHtml({ parentName, childName, classInfo, position, siteUrl }) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1A2B5E">
    <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
      <img src="${siteUrl}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto;width:160px;height:auto" />
    </div>
    <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
      <p>Hi ${parentName || 'there'},</p>
      <p>We're sorry to say that <strong>${classInfo.label}</strong> has now filled up with families who have already paid, and we hadn't yet received payment for <strong>${childName || 'your child'}</strong>'s place.</p>
      <p>As places are only confirmed once paid, we've moved ${childName || 'your child'} onto the waiting list for this class — you're currently <strong>#${position}</strong> in the queue, and we'll be in touch the moment a space opens up.</p>
      <p>If you'd like to be considered for a different class or session instead, or have any questions, just reply to this email or contact us at <a href="mailto:${contact.email}" style="color:#1A2B5E">${contact.email}</a>.</p>
      <p>We're sorry for any disappointment and hope to welcome ${childName || 'your child'} to a class soon.</p>
      <p style="margin-top:24px">${identity.name} 🤸</p>
    </div>
  </div>`;
}

exports.handler = async () => {
  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const siteUrl = process.env.SITE_URL || 'https://www.championgymnastics.co.uk';

  const termConfig = await getTermConfig();
  const CLASS_INFO = termConfig.classes;

  const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/forms`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const forms = await formsRes.json();
  const regForm = Array.isArray(forms) ? forms.find(f => f.name === 'registration') : null;
  if (!regForm) return { statusCode: 200, body: 'No registration form' };

  const subRes = await fetch(`https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let submissions = await subRes.json();
  if (!Array.isArray(submissions)) submissions = [];

  const payStore = getStore({ name: 'payments', siteID: siteId, token });
  const paidAmounts = {};
  try {
    const { blobs } = await payStore.list({ prefix: 'submission:' });
    const records = await Promise.all(blobs.map(b => payStore.get(b.key, { type: 'json' }).catch(() => null)));
    blobs.forEach((b, i) => {
      if (records[i]) paidAmounts[b.key.replace('submission:', '')] = records[i].amountPence || 0;
    });
  } catch (err) {
    console.error('waitlist-unpaid: could not read payments, aborting to avoid acting on stale data:', err.message);
    return { statusCode: 503, body: 'Payment verification unavailable' };
  }

  const settingsStore = getStore({ name: 'settings', siteID: siteId, token });
  const capacities = await settingsStore.get('class-capacities', { type: 'json' }).catch(() => ({})) || {};
  const overrides = await settingsStore.get('registration-overrides', { type: 'json', consistency: 'strong' }).catch(() => ({})) || {};

  // Apply overrides so class matching reflects any prior conversion/edit.
  submissions.forEach(s => { if (overrides[s.id]) Object.assign(s.data, overrides[s.id]); });

  // Paid-only enrolled count per class — matches class-capacity.js exactly.
  // A family enrolled in several classes only counts as a paid slot in the
  // ones their payment actually covers (see _payment-coverage-lib.js).
  const enrolled = {};
  CLASS_INFO.forEach(c => { enrolled[c.match] = 0; });
  submissions.forEach(s => {
    const covered = classesCoveredByPayment(enrolledPayableClasses(s, CLASS_INFO, overrides, termConfig), paidAmounts[s.id] || 0);
    covered.forEach(match => { if (match in enrolled) enrolled[match]++; });
  });

  const wlStore = getStore({ name: 'waiting-list', siteID: siteId, token });
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  let moved = 0;

  for (const s of submissions) {
    if (overrides[s.id] && overrides[s.id]._waitlisted) continue; // already processed
    if (overrides[s.id] && overrides[s.id]._manuallyHidden) continue; // coach hid this registration — leave it alone

    const data = s.data || {};
    const rawClass = data.class || '';
    const classStr = Array.isArray(rawClass) ? rawClass.join(' ') : rawClass;
    // Only consider a class this family hasn't actually paid for — a family
    // enrolled in several classes who's paid for one shouldn't be bumped
    // off it because a *different* one of their classes is unpaid.
    const classInfo = CLASS_INFO.find(c =>
      classStr.includes(c.match) && !isClassCovered(s, c.match, CLASS_INFO, paidAmounts[s.id] || 0, overrides, termConfig)
    );
    if (!classInfo || classInfo.trial) continue; // trials require upfront payment — not part of this flow
    if (!data.email || !data.child_name) continue;

    const cap = capacities[classInfo.match];
    if (!cap) continue; // no capacity limit set for this class — nothing to enforce
    if (enrolled[classInfo.match] < cap) continue; // still room

    const waitlistKey = CLASS_KEY_MAP[classInfo.match] || classInfo.match;

    try {
      const { blobs } = await wlStore.list({ prefix: waitlistKey }).catch(() => ({ blobs: [] }));
      const position = blobs.length + 1;

      await wlStore.setJSON(`${waitlistKey}_${Date.now()}_${s.id}`, {
        childName: data.child_name,
        parentName: data.parent_name || '',
        email: data.email,
        phone: data.phone || '',
        classMatch: waitlistKey,
        classLabel: classInfo.label,
        yearGroup: data.year_group || '',
        addedAt: new Date().toISOString(),
        autoMovedFromRegistration: s.id,
      });

      overrides[s.id] = { ...(overrides[s.id] || {}), _waitlisted: true, _waitlistedAt: new Date().toISOString() };
      await settingsStore.setJSON('registration-overrides', overrides);

      await transporter.sendMail({
        from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
        to: data.email,
        subject: `${data.child_name}'s place — ${classInfo.label} — moved to the waiting list`,
        html: emailHtml({ parentName: data.parent_name, childName: data.child_name, classInfo, position, siteUrl }),
      });

      moved++;
      console.log('waitlist-unpaid: moved', s.id, 'to waiting list for', waitlistKey, 'position', position);
    } catch (err) {
      console.error('waitlist-unpaid: failed for', s.id, err.message);
    }
  }

  return { statusCode: 200, body: `Moved ${moved} unpaid registration(s) to the waiting list.` };
};
