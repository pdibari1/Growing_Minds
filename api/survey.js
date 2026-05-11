// api/survey.js — Growing Minds feedback survey handler
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

function stars(n) {
  return '⭐'.repeat(n || 0) + '☆'.repeat(5 - (n || 0));
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
      nps,
      personalization,
      illustrations,
      childReaction,
      anythingWrong,
      upgradeReasons = [],
      oneThing,
      submittedAt
    } = req.body;

    if (nps === null || nps === undefined || !personalization || !illustrations) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // ── 1. Save to Redis (90-day TTL) ──
    const key = `survey:${storyId || 'anonymous'}:${Date.now()}`;
    const record = JSON.stringify({
      storyId, childName, email,
      nps, personalization, illustrations,
      childReaction, anythingWrong, upgradeReasons, oneThing,
      submittedAt: submittedAt || new Date().toISOString()
    });
    await redisRequest('SET', [key, record, 'EX', String(60 * 60 * 24 * 90)]);

    // Also append to a survey log list so we can retrieve all responses easily
    await redisRequest('LPUSH', ['survey:log', key]);
    await redisRequest('EXPIRE', ['survey:log', String(60 * 60 * 24 * 365)]);

    // ── 2. Email notification to admin ──
    const upgradeStr = upgradeReasons.length > 0
      ? upgradeReasons.join(', ')
      : '(none selected)';

    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a2e1f;">
  <div style="background:#2d6a4f;padding:1.5rem 2rem;border-radius:12px 12px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:1.3rem;">📊 New Survey Response — Growing Minds</h1>
    <p style="color:#d8f3dc;margin:0.4rem 0 0;font-size:0.9rem;">${childName ? `Story for: <strong>${childName}</strong>` : 'Anonymous'} &nbsp;·&nbsp; ${email || 'No email'} &nbsp;·&nbsp; ${new Date(submittedAt || Date.now()).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</p>
  </div>

  <div style="background:#fff;border:1px solid #e8f0e9;border-top:none;padding:1.5rem 2rem;border-radius:0 0 12px 12px;">

    <table style="width:100%;border-collapse:collapse;margin-bottom:1.5rem;">
      <tr>
        <td style="padding:0.6rem 0;border-bottom:1px solid #f0faf3;font-size:0.85rem;color:#6b8f71;width:180px;">NPS Score</td>
        <td style="padding:0.6rem 0;border-bottom:1px solid #f0faf3;font-weight:700;font-size:1.1rem;">${nps}/10 &nbsp; ${npsCategory(nps)}</td>
      </tr>
      <tr>
        <td style="padding:0.6rem 0;border-bottom:1px solid #f0faf3;font-size:0.85rem;color:#6b8f71;">Personalization</td>
        <td style="padding:0.6rem 0;border-bottom:1px solid #f0faf3;font-size:1rem;">${stars(personalization)} &nbsp; ${personalization}/5</td>
      </tr>
      <tr>
        <td style="padding:0.6rem 0;border-bottom:1px solid #f0faf3;font-size:0.85rem;color:#6b8f71;">Illustrations</td>
        <td style="padding:0.6rem 0;border-bottom:1px solid #f0faf3;font-size:1rem;">${stars(illustrations)} &nbsp; ${illustrations}/5</td>
      </tr>
      <tr>
        <td style="padding:0.6rem 0;font-size:0.85rem;color:#6b8f71;">Upgrade intent</td>
        <td style="padding:0.6rem 0;font-size:0.9rem;">${upgradeStr}</td>
      </tr>
    </table>

    ${childReaction ? `
    <div style="margin-bottom:1.25rem;">
      <div style="font-size:0.8rem;color:#6b8f71;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:0.4rem;">Child's Reaction</div>
      <div style="background:#f0faf3;border-left:3px solid #52b788;padding:0.85rem 1rem;border-radius:0 8px 8px 0;font-style:italic;font-size:0.95rem;line-height:1.5;">"${childReaction}"</div>
    </div>` : ''}

    ${anythingWrong ? `
    <div style="margin-bottom:1.25rem;">
      <div style="font-size:0.8rem;color:#c0392b;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:0.4rem;">⚠️ Something Was Wrong</div>
      <div style="background:#fff5f5;border-left:3px solid #e74c3c;padding:0.85rem 1rem;border-radius:0 8px 8px 0;font-size:0.95rem;line-height:1.5;">${anythingWrong}</div>
    </div>` : ''}

    ${oneThing ? `
    <div style="margin-bottom:1rem;">
      <div style="font-size:0.8rem;color:#6b8f71;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:0.4rem;">#1 Thing to Improve</div>
      <div style="background:#fefae0;border-left:3px solid #f9c74f;padding:0.85rem 1rem;border-radius:0 8px 8px 0;font-size:0.95rem;line-height:1.5;">${oneThing}</div>
    </div>` : ''}

    ${storyId ? `<p style="font-size:0.78rem;color:#b0c4b5;margin-top:1.5rem;border-top:1px solid #f0faf3;padding-top:0.75rem;">Story ID: ${storyId} &nbsp;·&nbsp; Redis key: ${key}</p>` : ''}
  </div>
</div>`;

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'Growing Minds <stories@growingminds.io>',
      to: 'hello@growingminds.io',
      subject: `📊 Survey — NPS ${nps}/10 ${npsCategory(nps)}${childName ? ` · ${childName}'s story` : ''}`,
      html
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[survey] error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
