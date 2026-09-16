// api/post-order-survey.js — feedback survey sent 3 weeks after the full book order
// Saves response to Redis and emails a formatted digest to hello@growingminds.io

import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisRequest(command, args) {
  const res = await fetch(`${REDIS_URL}/${command}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const json = await res.json();
  return json.result;
}

function npsCategory(score) {
  if (score >= 9) return '🟢 Promoter';
  if (score >= 7) return '🟡 Passive';
  return '🔴 Detractor';
}

function answerLabel(val) {
  return { yes: '✅ Yes', somewhat: '🤏 Somewhat', no: '❌ No' }[val] || val;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      storyId,
      childName,
      email,
      milestone,
      engaged,
      milestoneReflection,
      nps,
      submittedAt
    } = req.body;

    if (!engaged || !milestoneReflection || nps === null || nps === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // ── 1. Save to Redis (90-day TTL) ──
    const key = `postordersurvey:${storyId || 'anonymous'}:${Date.now()}`;
    const record = JSON.stringify({
      storyId, childName, email, milestone,
      engaged, milestoneReflection, nps,
      submittedAt: submittedAt || new Date().toISOString()
    });
    await redisRequest('SET', [key, record, 'EX', String(60 * 60 * 24 * 90)]);
    await redisRequest('LPUSH', ['postordersurvey:log', key]);
    await redisRequest('EXPIRE', ['postordersurvey:log', String(60 * 60 * 24 * 365)]);

    // ── 2. Email notification to admin ──
    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a2e1f;">
  <div style="background:#2d6a4f;padding:1.5rem 2rem;border-radius:12px 12px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:1.3rem;">📖 Post-Order Feedback — Growing Minds</h1>
    <p style="color:#d8f3dc;margin:0.4rem 0 0;font-size:0.9rem;">${childName ? `Story for: <strong>${childName}</strong>` : 'Anonymous'} &nbsp;·&nbsp; ${email || 'No email'} &nbsp;·&nbsp; ${new Date(submittedAt || Date.now()).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</p>
  </div>

  <div style="background:#fff;border:1px solid #e8f0e9;border-top:none;padding:1.5rem 2rem;border-radius:0 0 12px 12px;">
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:0.6rem 0;border-bottom:1px solid #f0faf3;font-size:0.85rem;color:#6b8f71;width:220px;">Kept child engaged?</td>
        <td style="padding:0.6rem 0;border-bottom:1px solid #f0faf3;font-weight:700;">${answerLabel(engaged)}</td>
      </tr>
      <tr>
        <td style="padding:0.6rem 0;border-bottom:1px solid #f0faf3;font-size:0.85rem;color:#6b8f71;">Helped think about milestone${milestone ? ` (${milestone})` : ''}?</td>
        <td style="padding:0.6rem 0;border-bottom:1px solid #f0faf3;font-weight:700;">${answerLabel(milestoneReflection)}</td>
      </tr>
      <tr>
        <td style="padding:0.6rem 0;font-size:0.85rem;color:#6b8f71;">Recommend to a friend (NPS)</td>
        <td style="padding:0.6rem 0;font-weight:700;font-size:1.1rem;">${nps}/10 &nbsp; ${npsCategory(nps)}</td>
      </tr>
    </table>
    ${storyId ? `<p style="font-size:0.78rem;color:#b0c4b5;margin-top:1.5rem;border-top:1px solid #f0faf3;padding-top:0.75rem;">Story ID: ${storyId} &nbsp;·&nbsp; Redis key: ${key}</p>` : ''}
  </div>
</div>`;

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'Growing Minds <stories@growingminds.io>',
      to: 'hello@growingminds.io',
      subject: `📖 Post-order feedback — NPS ${nps}/10 ${npsCategory(nps)}${childName ? ` · ${childName}'s story` : ''}`,
      html
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[post-order-survey] error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
