const { getTermConfig } = require('./_term-config');
const { getClassPaymentLinks } = require('./_class-payment-links-lib');
const { requireFeature } = require('./_require-feature');

// Public (no auth) endpoint for the customer-facing pay.html page. Read +
// auto-generate only — no ability to force-regenerate a specific class
// from here (that stays staff-only via class-payment-links.js).
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const blocked = requireFeature('payments');
  if (blocked) return blocked;

  try {
    const termConfig = await getTermConfig();
    const { links, termName } = await getClassPaymentLinks(termConfig);

    // Don't leak Square error details to unauthenticated visitors — just
    // omit any class that failed to generate a link.
    const safeLinks = links
      .filter(l => l.url)
      .map(({ match, label, pence, schedule, knavesmireOnly, url }) => ({ match, label, pence, schedule, knavesmireOnly, url }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify({ links: safeLinks, termName }),
    };
  } catch (err) {
    console.error('class-payment-links-public error:', err.message);
    // Fail gracefully — empty list rather than a broken page for a parent.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify({ links: [], termName: '' }),
    };
  }
};
