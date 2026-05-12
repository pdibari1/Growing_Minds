// api/survey-results.js — Admin endpoint: returns all survey responses from Redis
// Protected by ADMIN_WEBHOOK_SECRET token passed as ?token=

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_WEBHOOK_SECRET || 'dev-secret';

async function redisRequest(command, args) {
  const res = await fetch(
    `${REDIS_URL}/${command}/${args.map(encodeURIComponent).join('/')}`,
    { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
  );
  const json = await res.json();
  return json.result;
}

export default async function handler(req, res) {
  // Auth check
  const token = req.query.token || '';
  if (token !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get all keys from the survey log (up to 500 most recent)
    const keys = await redisRequest('LRANGE', ['survey:log', '0', '499']);
    if (!keys || keys.length === 0) {
      return res.status(200).json({ responses: [] });
    }

    // Fetch each response in parallel
    const responses = await Promise.all(
      keys.map(async (key) => {
        try {
          const raw = await redisRequest('GET', [key]);
          return raw ? JSON.parse(raw) : null;
        } catch (e) {
          return null;
        }
      })
    );

    const valid = responses
      .filter(Boolean)
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    return res.status(200).json({ responses: valid, total: valid.length });

  } catch (err) {
    console.error('[survey-results] error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
