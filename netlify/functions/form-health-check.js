// Runs daily at 8am UTC. Submits a test registration, verifies it arrives
// in Netlify Forms, deletes it, and emails an alert if anything fails.

const nodemailer = require('nodemailer');
const { identity, contact } = require('../../club.config');

const TEST_EMAIL = 'form-health-check@championgymnastics.internal';
const ALERT_TO   = contact.email;

async function sendAlert(subject, body) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
    to: ALERT_TO,
    subject,
    text: body,
  });
}

exports.handler = async () => {
  const siteUrl = process.env.SITE_URL || 'https://www.championgymnastics.co.uk';
  const siteId  = process.env.NETLIFY_SITE_ID;
  const token   = process.env.NETLIFY_ACCESS_TOKEN;

  if (!siteId || !token) {
    console.error('Missing NETLIFY_SITE_ID or NETLIFY_ACCESS_TOKEN');
    return { statusCode: 500, body: 'Missing env vars' };
  }

  // ── 1. Submit a test form ─────────────────────────────────────────────────
  const testData = new URLSearchParams({
    'form-name':       'registration',
    'child_name':      'Health Check Bot',
    'name':            'Health Check Bot',
    'dob':             '2020-01-01',
    'year_group':      'Year 1',
    'class':           'Minis – Gymnastics & Acro (Fri 4:00–5:00pm, Reception–Year 3)',
    'parent_name':     'Automated Test',
    'email':            TEST_EMAIL,
    'phone':           '00000000000',
    'school':          'Test School',
    'leave_unattended': 'No – parent/guardian handover required',
    'emergency_name':  'Test Contact',
    'emergency_phone': '00000000000',
    'medical':         'None',
  });

  try {
    const submitRes = await fetch(siteUrl + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: testData.toString(),
    });
    if (!submitRes.ok) throw new Error(`Submit returned ${submitRes.status}`);
    console.log('Test form submitted OK');
  } catch (err) {
    const msg = `Daily form health check FAILED — could not submit the registration form.\n\nError: ${err.message}\n\nPlease check the site at ${siteUrl}`;
    console.error(msg);
    await sendAlert(`🚨 Registration form is DOWN — ${identity.name}`, msg);
    return { statusCode: 200, body: 'alert sent: submit failed' };
  }

  // ── 2. Wait 10s for Netlify to process the submission ────────────────────
  await new Promise(r => setTimeout(r, 10000));

  // ── 3. Verify it appeared and clean it up ────────────────────────────────
  let foundId = null;
  try {
    const formsRes = await fetch(
      `https://api.netlify.com/api/v1/sites/${siteId}/forms`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const forms = await formsRes.json();
    const regForm = Array.isArray(forms) ? forms.find(f => f.name === 'registration') : null;

    if (!regForm) throw new Error('Registration form not found in Netlify');

    const subRes = await fetch(
      `https://api.netlify.com/api/v1/forms/${regForm.id}/submissions?per_page=20`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const subs = await subRes.json();
    const testSub = Array.isArray(subs)
      ? subs.find(s => s.data?.email === TEST_EMAIL)
      : null;

    if (!testSub) throw new Error('Test submission not found in Netlify Forms after 10s');

    foundId = testSub.id;
    console.log('Test submission verified, id:', foundId);

    // Delete it so it doesn't pollute the register
    await fetch(
      `https://api.netlify.com/api/v1/submissions/${foundId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    console.log('Test submission deleted');

  } catch (err) {
    const msg = `Daily form health check FAILED — the form submitted but the submission did not appear in Netlify Forms.\n\nError: ${err.message}\n\nPlease log in to Netlify and check the registration form manually.`;
    console.error(msg);
    await sendAlert(`🚨 Registration form verification FAILED — ${identity.name}`, msg);
    return { statusCode: 200, body: 'alert sent: verify failed' };
  }

  console.log('Form health check passed ✅');
  await sendAlert(
    `✅ Registration form is working — ${identity.name}`,
    `Daily check passed at ${new Date().toUTCString()}.\n\nA test submission was submitted, verified in Netlify Forms, and deleted successfully. The registration form is working normally.`
  );
  return { statusCode: 200, body: 'ok' };
};
