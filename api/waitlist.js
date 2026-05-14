// api/waitlist.js — Save international visitor emails to Redis list

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisRequest(command, args) {
  const res = await fetch(`${REDIS_URL}/${command}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const json = await res.json();
  return json.result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    // RPUSH appends to a Redis list; SADD would deduplicate but list preserves order
    await redisRequest('SADD', ['intl-waitlist', email.toLowerCase().trim()]);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('waitlist error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
