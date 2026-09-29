// Shared pro-rata pricing calc — used by class-capacity-public.js (what the
// registration page shows a visitor) and registration-notify.js (what the
// auto-response email + payment link actually charges). Keeping this in one
// place guarantees those two always agree: a family should never be quoted
// a pro-rated price on-screen and then billed the full term price by email.

const DAY_NAMES = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
const DAY_MS = 86400000;
// A session only counts as "used up" this late — not the instant the
// calendar day ticks over — so a family signing up on the morning of a
// lesson still gets quoted that lesson, right up until a minute after it
// actually starts.
const GRACE_MS = 60000;

// First "H:MM(am|pm)" in a schedule string like "Fridays, 4:00–5:00pm" is the
// start time; it usually has no meridiem of its own (only the end time does,
// e.g. "...5:00pm"), so borrow the next time's am/pm when the first lacks one
// — correct for every schedule here since none cross the noon/midnight
// boundary between a session's start and end.
function parseSessionStartTime(schedule) {
  const times = [...String(schedule || '').matchAll(/(\d{1,2}):(\d{2})\s*([ap]m)?/gi)];
  if (!times.length) return null;
  const [, hStr, mStr, meridiemOwn] = times[0];
  const meridiem = (meridiemOwn || (times[1] && times[1][3]) || '').toLowerCase();
  let hour = parseInt(hStr, 10);
  const minute = parseInt(mStr, 10);
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

// Returns { proratedPence, remaining, sessionsTotal } for a single class, or
// null if this class isn't eligible for pro-rating (trial, free, no weekday
// schedule, or the term config doesn't have what it needs).
function computeProratedPrice(config, classInfo) {
  // Every class carries its own `weeks` (session count) — used for both
  // its per-session Term Wizard price and, here, its pro-rata denominator.
  // A class sold as its own independently-priced block (e.g. the Friday
  // 1st/2nd Half Term classes, each a flat-price 6/7-session run with its
  // own start date) also carries prorateStartISO so it's measured from its
  // own start instead of the site-wide term — otherwise a family joining
  // partway through it would get pro-rated against a term it isn't even
  // part of. Classes without their own `weeks` (pre-dating this field)
  // fall back to the whole site term (termStartISO/sessionsTotal).
  const termStartISO = classInfo && classInfo.prorateStartISO || config.termStartISO;
  const sessionsTotal = classInfo && classInfo.weeks || config.sessionsTotal;
  if (!termStartISO || !sessionsTotal) return null;
  if (!classInfo || classInfo.trial || !(classInfo.pence > 0)) return null;

  const schedLower = (classInfo.schedule || '').toLowerCase();
  let weekday = null;
  for (const [name, num] of Object.entries(DAY_NAMES)) {
    if (schedLower.startsWith(name)) { weekday = num; break; }
  }
  if (weekday === null) return null;

  const termStart = new Date(termStartISO + 'T00:00:00');
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  let elapsed = 0;
  let d = new Date(termStart);
  while (d < today) {
    if (d.getDay() === weekday) elapsed++;
    d = new Date(d.getTime() + DAY_MS);
  }
  // Today's own session (if today is this class's day) only counts once
  // we're a minute past its start time — not from midnight.
  if (today.getDay() === weekday) {
    const startTime = parseSessionStartTime(classInfo.schedule);
    if (startTime) {
      const sessionStart = new Date(today);
      sessionStart.setHours(startTime.hour, startTime.minute, 0, 0);
      if (now >= new Date(sessionStart.getTime() + GRACE_MS)) elapsed++;
    }
  }
  elapsed = Math.min(elapsed, sessionsTotal);
  const remaining = sessionsTotal - elapsed;
  const proratedPence = Math.round(classInfo.pence / sessionsTotal * remaining);
  return { proratedPence, remaining, sessionsTotal };
}

// The price to actually charge for a class right now: pro-rated if this
// class has already had sessions run, otherwise its normal full price.
function currentPence(config, classInfo) {
  const p = computeProratedPrice(config, classInfo);
  return (p && p.remaining < p.sessionsTotal) ? p.proratedPence : classInfo.pence;
}

// { [match]: { proratedPence, remaining, sessionsTotal } } for every
// eligible class — same shape class-capacity-public.js has always returned.
function buildProratedMap(config, classList) {
  const prorated = {};
  classList.forEach(cls => {
    const p = computeProratedPrice(config, cls);
    if (p) prorated[cls.match] = p;
  });
  return prorated;
}

module.exports = { computeProratedPrice, currentPence, buildProratedMap };
