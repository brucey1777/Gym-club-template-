// Term dates and class prices live in club.config.js (this club's own
// timetable, kept alongside its other identity/theme settings) rather than
// here — a new club's setup means editing that one file, not this one.
// There is no staff-facing Term Wizard UI for it; changing it is a code
// change, deployed like any other.
const { term } = require('../../club.config');

async function getTermConfig() {
  return term;
}

module.exports = { getTermConfig, DEFAULT_CONFIG: term };
