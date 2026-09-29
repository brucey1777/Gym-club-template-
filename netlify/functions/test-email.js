const { validatePin } = require('./_coach-auth');
const { validateDevPin } = require('./auth-dev-pin');

// Mirror of CLASS_INFO — same ordering rules apply
const TEST_CLASSES = [
  { label: 'Trial – 11th Sep 4:00pm (Reception–Year 3)',  classValue: 'Trial – 11th Sep, 4:00–5:00pm (Reception–Year 3)' },
  { label: 'Trial – 11th Sep 5:00pm (Year 4-6)',          classValue: 'Trial – 11th Sep, 5:00–6:00pm (Year 4-6)' },
  { label: 'Trial – 18th Sep 4:00pm (Reception–Year 3)',  classValue: 'Trial – 18th Sep, 4:00–5:00pm (Reception–Year 3)' },
  { label: 'Trial – 18th Sep 5:00pm (Year 4-6)',          classValue: 'Trial – 18th Sep, 5:00–6:00pm (Year 4-6)' },
  { label: 'Trial – 25th Sep 4:00pm (Reception–Year 3)',  classValue: 'Trial – 25th Sep, 4:00–5:00pm (Reception–Year 3)' },
  { label: 'Trial – 25th Sep 5:00pm (Year 4-6)',          classValue: 'Trial – 25th Sep, 5:00–6:00pm (Year 4-6)' },
  { label: 'Minis (Fri 4:00–5:00pm)',                     classValue: 'Minis – Gymnastics & Acro (Fri 4:00–5:00pm, Reception–Year 3)' },
  { label: 'Juniors (Fri 5:00–6:00pm)',                   classValue: 'Juniors – Gymnastics & Acro (Fri 5:00–6:00pm, Year 4+)' },
  { label: 'Seniors Year 7+ (Fri 6:00–7:00pm)',           classValue: 'Seniors – Gymnastics & Acro (Fri 6:00–7:00pm, Year 7+)' },
  { label: 'Lunchtime – Year 1 & 2',                      classValue: 'Lunchtime Gymnastics – Year 1 & 2 (Wed 12:00–12:30pm)' },
  { label: 'Lunchtime – Year 3',                          classValue: 'Lunchtime Gymnastics – Year 3 (Wed 12:30–1:00pm)' },
  { label: 'After School – Year 4–6',                     classValue: 'After School Gymnastics – Year 4–6 (Wed 3:30–4:30pm)' },
];

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classes: TEST_CLASSES.map((c, i) => ({ index: i, label: c.label })) }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const authPin = event.headers['x-coach-pin'];
  const devPin  = event.headers['x-dev-pin'];
  if (!validatePin(authPin) && !validateDevPin(devPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  const { classIndex, toEmail } = body;
  if (classIndex === undefined || classIndex === null) {
    return { statusCode: 400, body: 'Missing classIndex' };
  }

  const cls = TEST_CLASSES[classIndex];
  if (!cls) {
    return { statusCode: 400, body: `Invalid classIndex — must be 0–${TEST_CLASSES.length - 1}` };
  }

  const destination = toEmail || process.env.GMAIL_USER;

  // Fake registration data
  const fakeSubmission = {
    form_name: 'registration',
    id: `test-${Date.now()}`,
    data: {
      parent_name: 'Test Parent',
      child_name: 'Test Child',
      email: destination,
      class: cls.classValue,
      year_group: 'Year 2',
      school: 'Knavesmire Primary',
      medical: 'None',
    },
  };

  // Call registration-notify handler directly
  const handler = require('./registration-notify').handler;
  const result = await handler({
    httpMethod: 'POST',
    body: JSON.stringify(fakeSubmission),
    headers: {},
  });

  return {
    statusCode: result.statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: result.statusCode === 200,
      class: cls.label,
      sentTo: destination,
      detail: result.body,
    }),
  };
};
