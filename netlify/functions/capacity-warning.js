const { getStore } = require('@netlify/blobs');
const { identity } = require('../../club.config');
const { requireFeature } = require('./_require-feature');
const nodemailer = require('nodemailer');
const { getTermConfig } = require('./_term-config');
const { createPaymentLink, emailHtml } = require('./_capacity-warning-lib');
const { resolvePence } = require('./_registration-pricing');
const { enrolledPayableClasses, classesCoveredByPayment, isClassCovered } = require('./_payment-coverage-lib');

// Runs daily, before waitlist-unpaid.js, via the schedule in netlify.toml.
// waitlist-unpaid.js only acts once a class is *already* full of paid
// registrations — by then an unpaid registrant has already lost their
// place. This gives them advance notice at 90% paid capacity, while they
// can still pay their way in, instead of finding out only once bumped.
const WARNING_THRESHOLD = 0.85;

exports.handler = async () => {
  const blocked = requireFeature('payments');
  if (blocked) return blocked;

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
    console.error('capacity-warning: could not read payments, aborting to avoid acting on stale data:', err.message);
    return { statusCode: 503, body: 'Payment verification unavailable' };
  }

  const settingsStore = getStore({ name: 'settings', siteID: siteId, token });
  const capacities = await settingsStore.get('class-capacities', { type: 'json' }).catch(() => ({})) || {};
  const overrides = await settingsStore.get('registration-overrides', { type: 'json', consistency: 'strong' }).catch(() => ({})) || {};

  submissions.forEach(s => { if (overrides[s.id]) Object.assign(s.data, overrides[s.id]); });

  // Paid-only enrolled count per class — matches class-capacity.js / waitlist-unpaid.js.
  // A family enrolled in several classes only counts as a paid slot in the
  // ones their payment actually covers, not every class they're listed
  // under (see _payment-coverage-lib.js).
  const enrolled = {};
  CLASS_INFO.forEach(c => { enrolled[c.match] = 0; });
  submissions.forEach(s => {
    const covered = classesCoveredByPayment(enrolledPayableClasses(s, CLASS_INFO, overrides, termConfig), paidAmounts[s.id] || 0);
    covered.forEach(match => { if (match in enrolled) enrolled[match]++; });
  });

  // Only warn for classes that have actually crossed the threshold.
  const nearFullClasses = new Set(
    CLASS_INFO.filter(c => capacities[c.match] && enrolled[c.match] / capacities[c.match] >= WARNING_THRESHOLD)
      .map(c => c.match)
  );
  if (nearFullClasses.size === 0) return { statusCode: 200, body: 'No classes near capacity' };

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  let sent = 0, failed = 0;

  for (const s of submissions) {
    if (overrides[s.id] && overrides[s.id]._waitlisted) continue; // already bumped — waitlist email already covers this
    if (overrides[s.id] && overrides[s.id]._capacityWarned) continue; // already warned once
    if (overrides[s.id] && overrides[s.id]._manuallyHidden) continue; // coach hid this registration — don't chase it

    const data = s.data || {};
    const rawClass = data.class || '';
    const classStr = Array.isArray(rawClass) ? rawClass.join(' ') : rawClass;
    // A near-full class this family is enrolled in but hasn't paid for —
    // if they're enrolled in several classes, only warn about ones this
    // specific payment doesn't cover (a family who's paid for one class
    // shouldn't be warned about it going full).
    const classInfo = CLASS_INFO.find(c =>
      classStr.includes(c.match) && nearFullClasses.has(c.match) &&
      !isClassCovered(s, c.match, CLASS_INFO, paidAmounts[s.id] || 0, overrides, termConfig)
    );
    if (!classInfo || classInfo.trial) continue; // trials require upfront payment — not part of this flow
    if (!data.email || !data.child_name) continue;

    const pence = resolvePence(overrides, s.id, classInfo, termConfig);
    const priceStr = pence ? `£${(pence / 100).toFixed(2)}` : '';

    let paymentUrl = `${siteUrl}/members.html`;
    try {
      paymentUrl = await createPaymentLink({
        classInfo, pence, termName: termConfig.termName, childName: data.child_name, submissionId: s.id, siteUrl,
      });
    } catch (err) {
      console.warn(`capacity-warning: Square link failed for ${s.id}:`, err.message);
    }

    try {
      await transporter.sendMail({
        from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
        to: data.email,
        subject: `${classInfo.label} is filling up — please pay soon to secure ${data.child_name}'s place`,
        html: emailHtml({ parentName: data.parent_name, childName: data.child_name, classInfo, priceStr, paymentUrl, siteUrl }),
      });

      overrides[s.id] = { ...(overrides[s.id] || {}), _capacityWarned: true, _capacityWarnedAt: new Date().toISOString() };
      await settingsStore.setJSON('registration-overrides', overrides);

      sent++;
      console.log(`capacity-warning: warned ${data.email} for submission ${s.id} (${classInfo.match})`);
    } catch (err) {
      failed++;
      console.error(`capacity-warning: failed to email ${data.email}:`, err.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ sent, failed, nearFullClasses: [...nearFullClasses] }) };
};
