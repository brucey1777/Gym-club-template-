# Gym Club Website Template

A white-label website/booking platform for kids' gymnastics (or similar)
clubs — public site, registration, staff register, capacity/revenue
tracking, and Square payments — driven per club by one config file.

**This repo is the sales/demo template.** It's a forked copy of a real,
working club site with all club-specific content (name, branding, contact
details, class timetable) replaced with placeholders in `club.config.js`.

- **To run a demo**: deploy this repo to its own Netlify site, using
  Square *sandbox* credentials (see `TEMPLATE-SETUP.md`) so a prospect
  clicking "Pay Now" doesn't move real money.
- **To sell to a real client**: fork *this* repo again (never point a
  paying client's site at this template repo directly), fill in
  `club.config.js` with their real details, and follow the full checklist
  in `TEMPLATE-SETUP.md`.

## What's config-driven vs. what still needs a manual pass

`club.config.js` covers identity, contact info, theme colours, feature
flags, and the class timetable — that's the bulk of what makes one club's
site different from another's, and it's all one file.

**Not yet config-driven** (see `TEMPLATE-SETUP.md`'s "What's NOT done yet"
section for the full list):
- Images (`logo.png`, hero photos, gallery) — this copy still has the
  original club's actual photography; swap these before demoing/selling.
- SEO/marketing copy (page titles, meta descriptions, hero/about section
  text) — genuinely different content per client, needs a copywriting
  pass rather than a config edit.
- The AI chatbot's system prompt (`netlify/functions/chat.js`,
  `enquiry-reply.js`) — bespoke per-club knowledge, not wired to config.
- The Supabase-backed parent portal — out of scope entirely so far
  (`features.parentPortal` stays `false`).

## Setup

See `TEMPLATE-SETUP.md` for the full new-club checklist: what to edit,
which environment variables to set, and how the feature-flag pattern
works.
