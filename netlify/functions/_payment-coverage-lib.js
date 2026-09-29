// A submission only ever has ONE payment record (one total amountPence),
// even when the family is enrolled in several payable classes — so a
// family who paid for just one of their classes still looks fully "paid"
// to anything that only checks whether a payment record exists at all
// (paidIds.has(submissionId)). That silently excludes them from every
// unpaid-targeting flow: Chase Unpaid, the deadline reminder emails, the
// near-full-class warning emails, and the waitlist-bump job.
//
// This mirrors staff.html's computePaymentBreakdown() (client-side, for the
// register's "⚠️ Partially paid" badge) so both sides agree on what "paid"
// means for a multi-class family.

const { resolvePence } = require('./_registration-pricing');

// Given the payable classes a submission is enrolled in and the amount
// actually paid, returns the Set of class `match` values that amount
// covers. Tries every combination of class prices to find the exact
// subset that sums to what was paid; if paid covers everything, all
// classes are covered; if the amount doesn't cleanly match any
// combination, nothing is treated as confirmed-covered — better to chase
// a family that's actually paid up than to silently skip one that isn't.
function classesCoveredByPayment(enrolledClassInfos, paidAmountPence) {
  const totalOwed = enrolledClassInfos.reduce((sum, c) => sum + c.pence, 0);
  if (paidAmountPence >= totalOwed) {
    return new Set(enrolledClassInfos.map(c => c.match));
  }
  const n = enrolledClassInfos.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += enrolledClassInfos[i].pence;
    if (sum === paidAmountPence) {
      const covered = new Set();
      for (let i = 0; i < n; i++) if (mask & (1 << i)) covered.add(enrolledClassInfos[i].match);
      return covered;
    }
  }
  return new Set();
}

// A Friday 1st-Half match key ('Minis'/'Juniors'/'Seniors') is also a
// substring of its own 2nd-Half class's value — e.g. "Minis – Gymnastics &
// Acro (Fri 4:00–5:00pm, Reception–Year 3), Term 2 (6 Nov–18 Dec)" still
// contains "Minis" — so a plain .includes(match) check would count a
// family enrolled ONLY in the 2nd Half as also enrolled in the 1st Half
// (inflating its capacity count, revenue, chase-payment targeting, etc).
// Require a 1st-Half match to not also be a Term 2 (2nd Half) value.
function classValueMatches(value, match) {
  if (!value.includes(match)) return false;
  if (['Minis', 'Juniors', 'Seniors'].includes(match)) return !value.includes('Term 2');
  return true;
}

// The payable classes (from CLASS_INFO) a submission is currently
// enrolled in, by class `match` (see classValueMatches above) — same
// matching convention used throughout (revenue-stats.js, class-capacity.js,
// etc). Prices reflect what this family was actually quoted at
// registration time (the price-lock in _registration-pricing.js), not
// necessarily today's CLASS_INFO price — a family who correctly paid their
// locked-in price must not be flagged as underpaid just because prices
// later changed. `overrides` is the registration-overrides blob (id ->
// record); pass it whenever available, or omit to fall back to current
// CLASS_INFO pricing.
// `config` is the full getTermConfig() result (not just its `.classes`
// array) — passed through to resolvePence() so a class with no price-lock
// on record (e.g. a trial manually moved into an ongoing class after the
// fact) falls back to the current fair pro-rated price instead of the raw
// full-term price. Optional for compatibility; omitting it just falls back
// further, to the raw CLASS_INFO price, as before.
function enrolledPayableClasses(sub, CLASS_INFO, overrides, config) {
  const cls = sub.data && sub.data.class;
  const list = Array.isArray(cls) ? cls : (cls ? [cls] : []);
  return CLASS_INFO
    .filter(c => c.pence > 0 && list.some(v => classValueMatches(v, c.match)))
    .map(c => overrides ? { ...c, pence: resolvePence(overrides, sub.id, c, config) } : c);
}

// Whether a specific class (by `match`) is covered by what this
// submission has actually paid.
function isClassCovered(sub, targetMatch, CLASS_INFO, paidAmountPence, overrides, config) {
  const enrolled = enrolledPayableClasses(sub, CLASS_INFO, overrides, config);
  return classesCoveredByPayment(enrolled, paidAmountPence).has(targetMatch);
}

// Whether ALL of a submission's enrolled payable classes are covered by
// what they've actually paid.
function isFullyCovered(sub, CLASS_INFO, paidAmountPence, overrides, config) {
  const enrolled = enrolledPayableClasses(sub, CLASS_INFO, overrides, config);
  if (!enrolled.length) return true;
  const covered = classesCoveredByPayment(enrolled, paidAmountPence);
  return enrolled.every(c => covered.has(c.match));
}

module.exports = { classesCoveredByPayment, enrolledPayableClasses, isClassCovered, isFullyCovered };
