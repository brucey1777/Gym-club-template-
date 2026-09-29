// Single source of truth for everything that's specific to THIS club, as
// opposed to the shared template codebase. Spinning up a new client site is
// meant to mean: fork the repo, rewrite this file, set that club's secrets
// as Netlify env vars (see TEMPLATE-SETUP.md), and deploy — no other file
// should need editing for a standard setup.
//
// ⚠️ THIS IS THE DEMO/SALES-TEMPLATE COPY — every value below is a
// placeholder, not a real club. When you sell this to a real client, fork
// this repo again and replace every value in this file with theirs. Never
// point a real client's Netlify site at THIS repo directly.
//
// Split into three parts:
//   - identity/theme/contact: public, safe to serve to the browser as-is
//     (see netlify/functions/club-config-public.js).
//   - features: on/off switches read by both server functions and the
//     client-side loader (assets/club-theme.js) to hide/disable whatever
//     this club's tier doesn't include.
//   - term: this club's current class timetable and pricing — the whole
//     "what does this club sell" picture lives in one file. Secrets
//     (Square keys, Gmail credentials, Supabase, coach PIN, etc) are NOT
//     here — those stay as Netlify environment variables, since they
//     differ per deploy and must never be committed to git.

const identity = {
  name: 'Starlight Gymnastics Club',
  shortName: 'Starlight Gymnastics',
  tagline: 'Fun, expert-coached gymnastics classes for kids — DEMO SITE',
  logoPath: '/logo.png',
  faviconPath: '/logo.png',
};

const contact = {
  // Use an address you actually monitor for demo sign-ups/test payments —
  // this is a live sandbox, not a sink.
  email: 'demo@example.com',
  adminEmail: 'demo@example.com',
  phone: '',
  address: '',
  website: 'https://example.com',
  siteUrlFallback: 'https://example.com',
  social: {
    facebook: '',
    instagram: '',
  },
};

// A distinct placeholder palette from any real client's, so it's obvious
// at a glance this is the template, not somebody's live site.
const theme = {
  colors: {
    gold: '#1AA6A6',
    goldBright: '#23C9C9',
    goldLight: '#7FE3E3',
    navy: '#2B1A5E',
    navyDark: '#1C1140',
    navyMid: '#3F2A7E',
    coral: '#FF6B6B',
    teal: '#00B4A2',
    purple: '#9B59E8',
    green: '#27AE60',
    sky: '#4DB8FF',
  },
};

// Every flag on for the demo, so a prospect sees the full product —
// registration, staff register/capacity/revenue, and Square payments
// (wired to a Square SANDBOX account — see TEMPLATE-SETUP.md; a demo
// "payment" must never touch real money).
const features = {
  payments: true,
  registration: true,
  staffPortal: true,
  parentPortal: false,
  chatbot: false,
};

// A simple, obviously-sample timetable — enough to demo registration,
// capacity, pro-rating and payments end to end without the real-world
// complexity of a real club's actual schedule.
const term = {
  termName: 'Sample Term',
  termStartISO: '2026-01-05',
  sessionsTotal: 10,
  classesStart: '5th January',
  termDatesDisplay: 'Mon 5 Jan – Mon 9 Mar · 10 sessions',
  classes: [
    { match: 'Trial – Mon 4pm', label: 'Trial – Monday 4:00pm (Rec–Y3)', pence: 500, weeks: 1, schedule: 'Monday, 4:00–5:00pm', trial: true, trialDateISO: '2026-01-05', group: 'Trials (£5, prepaid)', value: 'Trial – Monday, 4:00–5:00pm (Reception–Year 3)', meta: 'Reception–Year 3' },
    { match: 'Trial – Mon 5pm', label: 'Trial – Monday 5:00pm (Y4+)', pence: 500, weeks: 1, schedule: 'Monday, 5:00–6:00pm', trial: true, trialDateISO: '2026-01-05', group: 'Trials (£5, prepaid)', value: 'Trial – Monday, 5:00–6:00pm (Year 4+)', meta: 'Year 4+' },
    { match: 'Minis', label: 'Minis (Mon 4–5pm)', pence: 5000, weeks: 10, schedule: 'Mondays, 4:00–5:00pm', trial: false, group: 'Weekly Classes', value: 'Minis – Gymnastics (Mon 4:00–5:00pm, Reception–Year 3)', meta: 'Mon 4:00–5:00pm · Reception–Year 3 · full term' },
    { match: 'Juniors', label: 'Juniors (Mon 5–6pm)', pence: 5000, weeks: 10, schedule: 'Mondays, 5:00–6:00pm', trial: false, group: 'Weekly Classes', value: 'Juniors – Gymnastics (Mon 5:00–6:00pm, Year 4–6)', meta: 'Mon 5:00–6:00pm · Year 4–6 · full term' },
    { match: 'Seniors', label: 'Seniors (Mon 6–7pm)', pence: 5000, weeks: 10, schedule: 'Mondays, 6:00–7:00pm', trial: false, group: 'Weekly Classes', value: 'Seniors – Gymnastics (Mon 6:00–7:00pm, Year 7+)', meta: 'Mon 6:00–7:00pm · Year 7+ · full term' },
    { match: 'Private 1:1 Lesson – 30 minutes', label: 'Private 1:1 Lesson – 30 min', pence: 1500, weeks: 1, schedule: 'By arrangement with a coach', trial: false, payNow: true, group: 'Private Lessons', value: 'Private 1:1 Lesson – 30 minutes', meta: '30 min · subject to availability' },
  ],
};

module.exports = { identity, contact, theme, features, term };
