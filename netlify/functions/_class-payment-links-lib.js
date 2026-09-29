const { getStore } = require('@netlify/blobs');
const { contact } = require('../../club.config');

// Shared by class-payment-links.js (staff, PIN-gated, supports manual
// regenerate) and class-payment-links-public.js (customer-facing, no auth,
// read + auto-generate only). Generic, reusable payment links — one per
// class, not tied to any particular family or registration.

const SQUARE_API_VERSION = '2026-05-20';
// Wednesday classes run during the school day at Knavesmire Primary and are
// only open to its own pupils; Friday/trial sessions are open to anyone.
// Computed from the match string rather than a stored config field so it
// works even against an already-saved term-config blob that predates this.
const KNAVESMIRE_ONLY_MATCHES = ['Year 1 & 2 (Wed', 'Year 3 (Wed', 'Year 4–6'];
function isKnavesmireOnly(match) {
  return KNAVESMIRE_ONLY_MATCHES.includes(match);
}
// Bump when createLink()'s order shape changes, so previously-cached links
// (created before the change) get regenerated automatically instead of
// silently staying on the old shape.
const LINK_SCHEMA_VERSION = 3;

async function createLink(targetClass, termName) {
  const res = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      idempotency_key: `cgy-class-link-${targetClass.match}-${Date.now()}`,
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        reference_id: `classlink:${targetClass.match}`,
        line_items: [{
          name: `${targetClass.label} - ${termName}`,
          quantity: '1',
          base_price_money: { amount: targetClass.pence, currency: 'GBP' },
          note: `classlink:${targetClass.match}`,
        }],
      },
      checkout_options: {
        redirect_url: `${process.env.SITE_URL || 'https://www.championgymnastics.co.uk'}/index.html?paid=1#contact`,
        ask_for_shipping_address: false,
        merchant_support_email: contact.email,
        custom_fields: [{ title: "Child's full name" }],
      },
    }),
  });
  const result = await res.json();
  if (!res.ok) {
    const details = (result.errors || []).map(e => `${e.code}: ${e.detail || e.category}`).join('; ');
    throw new Error(`Square API ${res.status}${details ? ` - ${details}` : ''}`);
  }
  const url = result.payment_link?.url;
  if (!url) throw new Error('No URL in Square response');
  return url;
}

// Returns { links, termName } — one entry per payable class, generating or
// regenerating (and caching) any that are missing or stale. `forceKey`
// forces regeneration of one specific class regardless of cache state.
async function getClassPaymentLinks(termConfig, forceKey) {
  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;
  const store = getStore({ name: 'class-payment-links', siteID: siteId, token });

  const termName = termConfig.termName;
  const payableClasses = termConfig.classes.filter(c => c.pence > 0);

  const links = [];
  for (const cls of payableClasses) {
    const key = cls.match;
    let cached = await store.get(key, { type: 'json', consistency: 'strong' }).catch(() => null);

    const stale = !cached || cached.pence !== cls.pence || cached.version !== LINK_SCHEMA_VERSION || forceKey === key;
    if (stale) {
      try {
        const url = await createLink(cls, termName);
        cached = { url, pence: cls.pence, label: cls.label, version: LINK_SCHEMA_VERSION, createdAt: new Date().toISOString() };
        await store.setJSON(key, cached);
      } catch (err) {
        console.error('class-payment-links: Square error for', key, err.message);
        links.push({ match: key, label: cls.label, pence: cls.pence, schedule: cls.schedule, knavesmireOnly: isKnavesmireOnly(key), error: err.message });
        continue;
      }
    }

    links.push({ match: key, label: cls.label, pence: cls.pence, schedule: cls.schedule, knavesmireOnly: isKnavesmireOnly(key), url: cached.url, createdAt: cached.createdAt });
  }

  return { links, termName };
}

module.exports = { getClassPaymentLinks };
