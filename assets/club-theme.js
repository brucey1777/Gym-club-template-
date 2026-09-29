// Applies this club's branding and feature flags to the current page, from
// club-config-public.js. Include this script as early as possible (right
// after the :root CSS custom properties are defined) on every page that
// should be re-skinnable for another club.
//
// Two things it does:
//   1. Overrides the page's --gold/--navy/etc CSS custom properties with
//      this club's theme colours (the hex values baked into each page's
//      own <style> block are just the fallback shown before this runs, or
//      if the fetch fails).
//   2. Fills in every [data-club-field] element from identity/contact
//      (textContent by default; for an <img> or <a>, the relevant
//      src/href attribute instead) and hides every [data-feature] element
//      whose named feature flag is off.
//
// Failure is silent and non-blocking — a slow or failed fetch just leaves
// this page's own hardcoded defaults in place rather than breaking it.
(function () {
  var CSS_VAR_BY_KEY = {
    gold: '--gold', goldBright: '--gold-bright', goldLight: '--gold-light',
    navy: '--navy', navyDark: '--navy-dark', navyMid: '--navy-mid',
    coral: '--coral', teal: '--teal', purple: '--purple', green: '--green',
    sky: '--sky',
  };

  function applyTheme(colors) {
    if (!colors) return;
    var root = document.documentElement.style;
    Object.keys(CSS_VAR_BY_KEY).forEach(function (key) {
      if (colors[key]) root.setProperty(CSS_VAR_BY_KEY[key], colors[key]);
    });
  }

  function fieldValue(identity, contact, field) {
    switch (field) {
      case 'name': return identity.name;
      case 'shortName': return identity.shortName;
      case 'tagline': return identity.tagline;
      case 'logoPath': return identity.logoPath;
      case 'email': return contact.email;
      // Same address, ready to drop straight into an <a href>.
      case 'emailHref': return contact.email ? 'mailto:' + contact.email : null;
      case 'phone': return contact.phone;
      case 'address': return contact.address;
      case 'website': return contact.website;
      default: return null;
    }
  }

  function applyFields(identity, contact) {
    document.querySelectorAll('[data-club-field]').forEach(function (el) {
      var field = el.getAttribute('data-club-field');
      var value = fieldValue(identity, contact, field);
      if (value == null || value === '') return;
      var attr = el.getAttribute('data-club-attr');
      if (attr) el.setAttribute(attr, value);
      else el.textContent = value;
    });
  }

  function applyFeatures(features) {
    if (!features) return;
    document.querySelectorAll('[data-feature]').forEach(function (el) {
      var flag = el.getAttribute('data-feature');
      if (features[flag] === false) el.style.display = 'none';
    });
  }

  fetch('/.netlify/functions/club-config-public')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (config) {
      if (!config) return;
      applyTheme(config.theme && config.theme.colors);
      applyFields(config.identity || {}, config.contact || {});
      applyFeatures(config.features);
      document.dispatchEvent(new CustomEvent('club-config-ready', { detail: config }));
    })
    .catch(function () { /* keep this page's own defaults */ });
})();
