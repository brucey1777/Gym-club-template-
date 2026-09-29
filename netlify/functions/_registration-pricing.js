// Locks in the price a family was quoted at registration time, so a later
// Term Wizard price change never changes what an already-registered (but
// still unpaid) family owes — every subsequently-generated payment link
// for them (chase-payment broadcasts, capacity warnings, deadline
// reminders) honours the original price, not whatever's current.
//
// Stored inside the existing `registration-overrides` settings blob
// (keyed by submission id) since every function that touches a submission
// already reads that blob for other per-submission state (_waitlisted,
// _capacityWarned, etc).

const { getStore } = require('@netlify/blobs');
const { currentPence } = require('./_prorated-pricing');

function settingsStore() {
  return getStore({ name: 'settings', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_ACCESS_TOKEN });
}

// Called once, at registration time. Never overwrites an existing record —
// the whole point is that this price can't drift after the fact.
async function recordOriginalPricing(submissionId, classInfos) {
  if (!submissionId || !Array.isArray(classInfos) || !classInfos.length) return;
  const store = settingsStore();
  const overrides = await store.get('registration-overrides', { type: 'json' }).catch(() => ({})) || {};
  if (overrides[submissionId] && overrides[submissionId]._originalPricing) return;

  const pricing = {};
  classInfos.forEach(ci => { pricing[ci.match] = ci.pence; });
  overrides[submissionId] = { ...(overrides[submissionId] || {}), _originalPricing: pricing };
  await store.setJSON('registration-overrides', overrides);
}

// The price to actually charge for a given submission + class: the price
// it was originally registered at if we have one on record, otherwise the
// current fair (pro-rated) price — e.g. a trial manually moved into an
// ongoing class part-way through term never had a lock recorded for that
// class, so falling back to the raw un-prorated price would mean whatever
// the coach correctly charges (the fair mid-term amount) can never exactly
// match what classesCoveredByPayment() expects, leaving the conversion
// permanently "unpaid" in capacity/revenue even once it's genuinely paid.
function resolvePence(overrides, submissionId, classInfo, config) {
  const original = overrides && overrides[submissionId] && overrides[submissionId]._originalPricing;
  if (original && original[classInfo.match] !== undefined) return original[classInfo.match];
  return config ? currentPence(config, classInfo) : classInfo.pence;
}

module.exports = { recordOriginalPricing, resolvePence };
