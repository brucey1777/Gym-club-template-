const { getStore } = require('@netlify/blobs');
const { identity } = require('../../club.config');
const nodemailer = require('nodemailer');
const { sendPushToAll } = require('./_push-lib');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Bad request' };
  }

  const { name, email, message } = body;
  if (!name || !email || !message) return { statusCode: 400, body: 'Missing fields' };

  // Save to Blobs for the scheduler to pick up
  const siteId = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  const store  = getStore({ name: 'enquiries', siteID: siteId, token });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await store.setJSON(id, {
    id, name, email, message,
    receivedAt: new Date().toISOString(),
    replied: false,
  });

  // Send instant confirmation to the parent
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `"${identity.name}" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `Thanks for getting in touch, ${name.split(' ')[0]}!`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a0a2e">
          <p>Hi ${name.split(' ')[0]},</p>
          <p>Thanks so much for your message — we've received it and will get back to you shortly!</p>
          <p>In the meantime, you can find lots of useful info on our website at
             <a href="https://www.championgymnastics.co.uk" style="color:#F5A623">championgymnastics.co.uk</a>.</p>
          <p>Speak soon,<br>
             <strong>Christina</strong><br>
             ${identity.name}</p>
        </div>`,
    });
  } catch (err) {
    console.error('Confirmation email error:', err);
  }

  // Push notification to any staff devices that have opted in — best-effort,
  // never blocks the parent's response either way.
  try {
    await sendPushToAll({
      title: '📧 New Enquiry',
      body: `${name}: ${message.length > 100 ? message.slice(0, 100) + '…' : message}`,
      url: '/staff.html',
    });
  } catch (err) {
    console.error('Push notification error:', err);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
