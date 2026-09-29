const { getStore } = require('@netlify/blobs');
const { identity } = require('../../club.config');
const nodemailer = require('nodemailer');

// Runs daily at 20:00 UTC (after every possible session has finished) via
// the schedule in netlify.toml. Works out which sessions were expected to
// run today (mirroring getTodaySession() in staff.html — kept in sync
// manually if term dates or the class list ever change), checks whether a
// register was actually submitted for each, and emails the coach a
// reminder listing any that are missing.

// Register text must match exactly what submitRegister() in staff.html
// stores as `className` — the *displayed text* of the register-filter
// dropdown option, not its value.
function getExpectedSessions() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const dow = now.getDay();

  if (m === 9 && d === 11) return [
    '🎁 Trial — 11th Sep, 4:00–5:00pm (Reception–Year 3)',
    '🎁 Trial — 11th Sep, 5:00–6:00pm (Year 4-6)',
  ];
  if (dow === 3) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const termStart = new Date(2026, 8, 16);
    const termEnd = new Date(2026, 11, 16);
    const halfTerm = new Date(2026, 9, 28);
    if (today >= termStart && today <= termEnd && today.getTime() !== halfTerm.getTime()) {
      return ['Lunchtime — Year 1 & 2', 'Lunchtime — Year 3', 'After School — Year 4–6'];
    }
  }
  if (dow === 5) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const t1Start = new Date(2026, 8, 18);
    const t1End = new Date(2026, 9, 23);
    const t2Start = new Date(2026, 10, 6);
    const t2End = new Date(2026, 11, 11);
    const inT2 = today >= t2Start && today <= t2End;
    if ((today >= t1Start && today <= t1End) || inT2) {
      // Must match the register-filter option text staff.html's
      // submitRegister() stores as `className` — split into 1st/2nd Half
      // since the Friday register filter itself was split (each half is
      // submitted separately), not the single combined label this used to
      // check for.
      const half = inT2 ? '2nd Half' : '1st Half';
      return [
        `Friday — Minis, ${half} (4:00–5:00pm)`,
        `Friday — Juniors, ${half} (5:00–6:00pm)`,
        `Friday — Seniors, ${half} (6:00–7:00pm)`,
      ];
    }
  }
  return [];
}

exports.handler = async () => {
  const expected = getExpectedSessions();
  if (expected.length === 0) return { statusCode: 200, body: 'No sessions expected today.' };

  const todayISO = new Date().toISOString().slice(0, 10);
  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_ACCESS_TOKEN;

  const registerStore = getStore({ name: 'registers', siteID: siteId, token });
  const reminderStore = getStore({ name: 'register-reminders', siteID: siteId, token });

  const { blobs } = await registerStore.list({ includeMeta: true }).catch(() => ({ blobs: [] }));
  const submittedToday = new Set(
    blobs.filter(b => b.metadata?.date === todayISO).map(b => b.metadata?.className)
  );

  const missing = expected.filter(session => !submittedToday.has(session));
  if (missing.length === 0) return { statusCode: 200, body: 'All registers submitted.' };

  // Avoid re-sending if this has already fired for today (e.g. a retry).
  const alreadyReminded = await reminderStore.get(todayISO, { type: 'json', consistency: 'strong' }).catch(() => null);
  if (alreadyReminded) return { statusCode: 200, body: 'Reminder already sent today.' };

  const siteUrl = process.env.SITE_URL || 'https://www.championgymnastics.co.uk';
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1A2B5E">
      <div style="background:#111C3E;padding:22px;text-align:center;border-radius:14px 14px 0 0">
        <img src="${siteUrl}/logo.png" alt="${identity.name}" width="160" style="display:block;margin:0 auto 4px;width:160px;height:auto" />
      </div>
      <div style="background:#FFFBF2;padding:26px;border-radius:0 0 14px 14px;border:1px solid #E8E0F0">
        <p>Hi,</p>
        <p>Looks like today's register${missing.length > 1 ? 's haven’t' : ' hasn’t'} been submitted yet for:</p>
        <ul style="padding-left:20px">
          ${missing.map(s => `<li style="margin-bottom:4px">${s}</li>`).join('')}
        </ul>
        <p>Attendance won't be tracked (and trial follow-up emails won't fire) until it's submitted.</p>
        <div style="text-align:center;margin:22px 0">
          <a href="${siteUrl}/staff.html" style="background:#F5A623;color:#111C3E;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 30px;border-radius:50px;display:inline-block">Submit Register →</a>
        </div>
        <p style="margin-top:24px">${identity.name} 🤸</p>
      </div>
    </div>`;

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      subject: `⚠️ Register not submitted — ${missing.join(', ')}`,
      html,
    });
    await reminderStore.setJSON(todayISO, { sentAt: new Date().toISOString(), missing });
    return { statusCode: 200, body: `Reminder sent for: ${missing.join(', ')}` };
  } catch (err) {
    console.error('register-reminder: email error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
