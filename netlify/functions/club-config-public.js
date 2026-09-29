// Public (no auth) endpoint exposing the non-secret parts of club.config.js
// — identity, theme colours, contact details, feature flags — so static
// pages can brand and gate themselves at runtime from one file (see
// assets/club-theme.js) instead of every page hardcoding this club's name/
// colours/contact info directly. Never add anything here that isn't
// already safe to show a site visitor — secrets stay in Netlify env vars.
const { identity, contact, theme, features } = require('../../club.config');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      // Branding/features change rarely — cache generously, same pattern
      // as class-capacity-public.js.
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify({ identity, contact, theme, features }),
  };
};
