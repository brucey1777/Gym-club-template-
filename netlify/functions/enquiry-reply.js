const { getStore } = require('@netlify/blobs');
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');

const DELAY_MS = 2 * 60 * 60 * 1000; // 2 hours

const SYSTEM_PROMPT = `You are Christina, the coach and founder of Champion Gymnastics York. You're writing a personal email reply to a parent who got in touch with a general enquiry.

Key facts about the club:
- Wednesday school clubs at Knavesmire Primary School (Trafalgar Street, York YO23 1HY) — Knavesmire pupils only
  · Year 1 & 2: 12:00–12:30pm · £65 for the term
  · Year 3: 12:30–1:00pm · £65 for the term
  · Year 4–6: 3:30–4:30pm · £130 for the term
  · Autumn term: Wed 16 Sept – Wed 16 Dec 2026 · 13 classes · No class 28 Oct (half-term)
  · Fees paid as one full-term payment
- Friday Gymnastics & Acro at the Main Hall, Knavesmire Primary School — open to all
  · Minis (Reception–Year 3): 4:00–5:00pm
  · Juniors (Year 4–6): 5:00–6:00pm
  · Seniors (Year 7+): 6:00–7:00pm
  · One Autumn term, booked in two halves (not two separate terms):
    - 1st half: Fri 18 Sep – 23 Oct · 6 sessions · £60
    - 2nd half: Fri 6 Nov – 18 Dec · 7 sessions · £70
- Trial classes: £8 per session, must be prepaid to secure a spot
  · Fri 11th Sep 2026: 4:00–5:00pm (Reception–Year 3), 5:00–6:00pm (Year 4–6)
  · Fri 18th Sep 2026: 4:00–5:00pm (Reception–Year 3), 5:00–6:00pm (Year 4–6)
  · Fri 25th Sep 2026: 4:00–5:00pm (Reception–Year 3), 5:00–6:00pm (Year 4–6)
- Sign up at: https://www.championgymnastics.co.uk/#contact
- Email: championgymnasticsyork@gmail.com

Writing style:
- Warm, friendly and encouraging — like a message from a real coach who loves what they do
- Keep it concise, 3–5 short paragraphs max
- Use the parent's first name
- Don't use bullet points or headers in the reply — write in natural flowing sentences
- Never use phrases like "I hope this email finds you well", "please don't hesitate", "as per", or anything that sounds corporate or AI-generated
- Never use a hyphen or dash of any kind (-, – or —) anywhere in the email, including in compound words or age ranges — rephrase instead (e.g. "aged 4 to 6" not "4-6", "one to one" not "one-to-one")
- If you need to ask the parent something (like their child's age), work it naturally into a sentence within the body of the email — never end the email with a short, disconnected question sitting on its own line
- Sign off as Christina
- If the enquiry is about something you don't have specific information on, say you'd be happy to chat more and invite them to reply or come along to a trial`;

// Drafts a reply and notifies the coach — it no longer sends anything to the
// parent directly. Staff review/edit the draft in the staff.html Enquiries
// tab and send it themselves via enquiry-send-reply.js.
function notificationHtml({ name, email, message, draftReply, siteUrl }) {
  const escape = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const draftHtml = escape(draftReply).split(/\n{2,}/).map(p => `<p style="margin:0 0 10px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a0a2e;line-height:1.6">
      <p><strong>New enquiry from ${escape(name)}</strong> (${escape(email)})</p>
      <div style="background:#F5F0FF;border-radius:10px;padding:14px 16px;margin:10px 0"><strong>Their message:</strong><br>${escape(message).replace(/\n/g, '<br>')}</div>
      <p style="margin-top:18px"><strong>Draft reply ready for you to review:</strong></p>
      <div style="background:#FFFBF2;border:1px solid #E8E0F0;border-radius:10px;padding:14px 16px">${draftHtml}</div>
      <div style="text-align:center;margin:22px 0">
        <a href="${siteUrl}/staff.html" style="background:#F5A623;color:#111C3E;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 30px;border-radius:50px;display:inline-block">Review &amp; Send →</a>
      </div>
    </div>`;
}

exports.handler = async () => {
  const siteId = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_ACCESS_TOKEN;
  const siteUrl = process.env.SITE_URL || 'https://www.championgymnastics.co.uk';
  const store  = getStore({ name: 'enquiries', siteID: siteId, token });

  const { blobs } = await store.list();
  const now = Date.now();

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  for (const blob of blobs) {
    const enquiry = await store.get(blob.key, { type: 'json' });
    if (!enquiry || enquiry.replied || enquiry.draftReply) continue;

    const age = now - new Date(enquiry.receivedAt).getTime();
    if (age < DELAY_MS) continue;

    // Generate draft reply
    let draftReply;
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Parent's name: ${enquiry.name}\nParent's message: ${enquiry.message}\n\nWrite a warm, personal email reply.`,
        }],
      });
      draftReply = response.content[0].text;
    } catch (err) {
      console.error('Claude error:', err);
      continue;
    }

    try {
      await transporter.sendMail({
        from: `"Champion Gymnastics York" <${process.env.GMAIL_USER}>`,
        to: process.env.GMAIL_USER,
        subject: `📨 New enquiry from ${enquiry.name} — draft reply ready`,
        html: notificationHtml({ name: enquiry.name, email: enquiry.email, message: enquiry.message, draftReply, siteUrl }),
      });

      // Save the draft — NOT marked as replied. Staff send it (as-is or
      // edited) from the staff.html Enquiries tab via enquiry-send-reply.js.
      await store.setJSON(blob.key, { ...enquiry, draftReply, draftGeneratedAt: new Date().toISOString() });
      console.log(`Drafted reply and notified coach for ${enquiry.email}`);
    } catch (err) {
      console.error('Notification email error:', err);
    }
  }

  return { statusCode: 200, body: 'Done' };
};
