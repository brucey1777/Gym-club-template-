// Server-side half of the club.config.js feature flags — the client-side
// loader (assets/club-theme.js) hides a disabled feature's UI, but a
// direct request to its function must also be refused, since hiding a
// button is not the same as actually switching a paid tier off.
//
// Usage at the top of a gated function's handler:
//   const blocked = requireFeature('payments');
//   if (blocked) return blocked;
const { features } = require('../../club.config');

function requireFeature(flag) {
  if (features[flag] !== false) return null;
  return {
    statusCode: 403,
    body: JSON.stringify({ error: `This site's plan doesn't include ${flag}.` }),
  };
}

module.exports = { requireFeature };
