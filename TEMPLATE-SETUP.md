# Setting up a new club on this template

This codebase is meant to serve many clubs from one GitHub repo, each
deployed as its own Netlify site pointed at its own `club.config.js` and
its own environment variables. This doc is the checklist for spinning up a
new one.

## What "per club" actually means here

- **One GitHub repo** (this one, or a fork of it) is the template.
- **One Netlify site per client**, each built from that repo/branch, with
  its own env vars and its own `club.config.js` committed to that client's
  branch or fork.
- Secrets (Square, Gmail, Supabase, coach PIN, AI keys) are **never** in
  `club.config.js` — they're Netlify environment variables, set per site in
  the Netlify dashboard (Site settings → Environment variables).

## Setting up the demo/sales site

This repo's `club.config.js` already holds placeholder demo content
("Starlight Gymnastics Club"). To stand up a live demo you can show
prospects:

1. Create a Netlify site pointed at this repo (its own site — not the same
   one any real client uses).
2. Get **Square sandbox** credentials (Square Developer Dashboard → your
   application → Sandbox tab): a sandbox `SQUARE_ACCESS_TOKEN` and
   `SQUARE_LOCATION_ID`. Set those as this demo site's env vars along with
   the rest of the usual list below — sandbox payments look and behave
   exactly like real ones (full Square Checkout flow, test card numbers)
   but never move real money, so a prospect can click all the way through
   "Pay Now" safely.
3. Set up the Square webhook against the sandbox application (Square
   Developer Dashboard → Webhooks, Sandbox), pointed at
   `https://<your-demo-site>/.netlify/functions/square-webhook`, and use
   its **sandbox** signature key for `SQUARE_WEBHOOK_SIGNATURE_KEY`.
4. Use a real inbox you control for `GMAIL_USER`/`contact.email` — demo
   registrations will send real confirmation emails.

When you land a real client, don't touch this repo further — fork it
fresh (see the checklist below) so their config and secrets never mix with
the demo's.

## New club checklist

1. **Fork/branch the repo** for the new client.
2. **Edit `club.config.js`** (repo root) — this is the only file a standard
   setup should need to touch:
   - `identity` — name, short name, tagline, logo/favicon paths (drop the
     new logo file in the repo and point `logoPath`/`faviconPath` at it).
   - `contact` — email, admin email, phone, address, website, socials.
   - `theme.colors` — the palette; every CSS custom property the site's
     pages reference (`--gold`, `--navy-dark`, etc) gets overridden from
     here at runtime by `assets/club-theme.js`.
   - `features` — turn off whatever this client's tier doesn't include
     (see **Feature flags** below).
   - `term` — this club's class timetable and pricing (was previously
     hardcoded in `netlify/functions/_term-config.js`; now lives here).
     There's no staff-facing editor for it — changing it is a code change,
     deployed like any other.
3. **Create the Netlify site**, pointed at the new branch/fork.
4. **Set environment variables** on that site (Site settings → Environment
   variables): `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`,
   `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_NOTIFICATION_URL`,
   `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `NETLIFY_SITE_ID`,
   `NETLIFY_ACCESS_TOKEN`, `SITE_URL`, `COACH_PIN`, `DEV_PIN`, and — only if
   that client's tier includes them — `ANTHROPIC_API_KEY`/
   `OPENAI_API_KEY` (chatbot), `SUPABASE_URL`/`SUPABASE_ANON_KEY`/
   `SUPABASE_SECRET_KEY` (parent portal), `VAPID_PUBLIC_KEY`/
   `VAPID_PRIVATE_KEY` (push notifications).
5. **Set up the Square webhook** on the new client's Square account,
   pointed at `https://<their-site>/.netlify/functions/square-webhook`.
6. **Replace the logo/hero images** in the repo (`logo.png`,
   `hero-gymnast-*.png`, anything under `images/`) with the client's own.
7. **Deploy**, then load the site and confirm the branding/colours came
   through (check the browser console for a failed
   `club-config-public` fetch if they didn't).

## Feature flags

Each flag in `club.config.js`'s `features` object is enforced in **two**
places — the client-side loader hides the entry point, and the relevant
function refuses the request even if it's called directly:

| Flag | Client-side (hidden via `data-feature="…"`) | Server-side (`requireFeature('…')`) |
|---|---|---|
| `payments` | members.html "Pay Fees" tab/cart | `create-checkout.js`, `send-payment-link.js`, `send-payment-reminders.js` (scheduled), `capacity-warning.js` (scheduled), `trial-followup.js` (scheduled, currently disabled anyway), `trial-checkout.js`, `class-payment-links.js`, `class-payment-links-public.js`, `square-payments.js` |

`payments` is fully wired both ways now — every function that generates a
Square payment link, sends a payment-chasing email, or reads the Square
ledger refuses the request (or, for the scheduled ones, no-ops) when
`features.payments` is off, in addition to the client-side UI being
hidden. `waitlist-unpaid.js` was deliberately left ungated: moving an
unpaid family to a waiting list is really about capacity, not payments,
so it still makes sense to run even for a club that doesn't take online
payment. `broadcast-message.js` and `registration-notify.js` weren't
gated either — the former's payment button is opt-in per message (a
non-payment broadcast should still work with `payments` off), and the
latter already skips generating a link whenever a class's price is 0,
which is what a no-payments club's classes should be configured as.

**`registration` and `staffPortal` are not wired up yet** — their flags
exist in `club.config.js` but nothing reads them. Wiring them the same
way (`requireFeature` + `data-feature`) would mean:
- `registration` — index.html's sign-up form / `registration-notify.js`.
- `staffPortal` — staff.html's register/capacity/revenue views and the
  functions behind them (`class-capacity.js`, `revenue-stats.js`,
  `waitlist-unpaid.js`, `broadcast-message.js`, `mark-as-paid.js`, etc).
- `parentPortal` / `chatbot` — the Supabase portal and AI chatbot weren't
  templated in this pass at all (see below); their flags exist in
  `club.config.js` but nothing reads them yet.

To add a new gate: import `requireFeature` from
`netlify/functions/_require-feature.js` and return early if it's set, and
tag the corresponding UI element(s) with `data-feature="yourFlagName"` so
`assets/club-theme.js` hides them when that flag is off.

## What's already templated

- `club.config.js` — identity, contact, theme colours, feature flags, and
  the class timetable (moved out of `_term-config.js`).
- `netlify/functions/club-config-public.js` — serves the non-secret parts
  to the browser.
- `assets/club-theme.js` — client-side loader; include it on any page that
  should re-skin (`<script src="/assets/club-theme.js" defer></script>`,
  right before `</head>`). It overrides `:root` CSS custom properties from
  `theme.colors`, fills in any `[data-club-field]` element (see
  `index.html`'s nav logo/footer for examples — `name`, `shortName`,
  `tagline`, `logoPath`, `email`, `emailHref` for a mailto `<a href>`,
  `phone`, `address`, `website`), and hides any `[data-feature]` element
  whose flag is off. Wired into every page: `index.html`, `members.html`,
  `staff.html`, `absence.html`, `parent-portal.html`, `terms.html`,
  `thank-you.html`, `waiting-list.html`, `crossword.html`.
- `netlify/functions/_require-feature.js` — server-side gate, wired into
  `create-checkout.js` and `send-payment-link.js` as the reference
  implementation.
- Every `netlify/functions/*.js` email template that sent mail as
  "Champion Gymnastics York" now pulls `identity.name`/`contact.email`/
  `contact.adminEmail` from `club.config.js` instead — that was the bulk
  of the sweep (~25 functions). The two AI chatbot files (`chat.js`,
  `enquiry-reply.js`) were deliberately left alone; see below.
- A handful of dynamically-built (JS string, not static markup) messages
  in `absence.html`, `waiting-list.html`, `parent-portal.html` still say
  the club name/email directly — noted below, not yet swapped.

## What's NOT done yet — needed before a real second club goes live

This was scoped deliberately as a first pass covering the core site
(registration, staff register, capacity/revenue, members payments) — the
foundation and the bulk of the sweep are in place, but a few things remain
before selling this to another club:

- **A few JS-string (not static-markup) occurrences** of the club name/
  email inside client-side `<script>` blocks — `absence.html` and
  `waiting-list.html`'s error-toast fallback text, `parent-portal.html`'s
  "no bookings found" empty state. `data-club-field` only applies to
  static markup present at page load; these are built dynamically in JS,
  so they'd need to read from the already-fetched club-config (e.g. off
  the `club-config-ready` event `assets/club-theme.js` dispatches) instead.
- **SEO/marketing copy** (page `<title>`, meta descriptions, Open Graph
  tags, JSON-LD structured data, the hero/about section copy, the AI
  chatbot's system prompt in `chat.js`/`enquiry-reply.js`) — this is
  genuinely different content per client, not a variable swap, so it needs
  a copywriting pass per new club rather than automation.
- **The venue address** in the registration confirmation email
  ("Knavesmire Primary School, Trafalgar Street...") isn't wired to
  `contact.address` yet.
- **Remaining feature-flag gates** — see the table above (`registration`,
  `staffPortal`, `parentPortal`, `chatbot` flags exist but nothing reads
  them yet besides `payments`).
- **Supabase parent portal and AI chatbot** — out of scope for this pass
  entirely; templating them means deciding how per-client Supabase
  projects/schemas get provisioned, which wasn't tackled here.
- **Images** — logo, hero photos, gallery photos are still this club's
  actual images; a new client needs their own dropped in and referenced.

None of this blocks running the current (Champion Gymnastics York) site —
it's unaffected functionally, since `club.config.js`'s defaults are
exactly its existing values.
