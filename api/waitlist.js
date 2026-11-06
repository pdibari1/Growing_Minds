// api/waitlist.js — Waitlists in Redis
//
// POST { email }                         → international visitors list (intl-waitlist)
// POST { list: 'launch', email, childName, childAge, milestone, source }
//                                        → pre-launch waitlist (launch-waitlist)
// GET  ?token=<ADMIN_WEBHOOK_SECRET>[&format=csv]
//                                        → export the pre-launch waitlist

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_WEBHOOK_SECRET;

const LAUNCH_KEY = 'launch-waitlist';
const MILESTONES = [
  'Starting school', 'New baby or sibling', 'Moving to a new home', 'Learning something new',
  'Making friends', 'Managing big feelings', 'A big life change', 'Something else',
];

async function redisRequest(command, args) {
  const res = await fetch(`${REDIS_URL}/${command}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const json = await res.json();
  return json.result;
}

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // keep spreadsheets from running it as a formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportLaunchList(req, res) {
  // Parents' emails and children's names: no export without a real secret set.
  if (!ADMIN_SECRET || (req.query.token || '') !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // HGETALL returns a flat [field, value, field, value, …] array.
  const flat = (await redisRequest('HGETALL', [LAUNCH_KEY])) || [];
  const entries = [];
  for (let i = 1; i < flat.length; i += 2) {
    try { entries.push(JSON.parse(flat[i])); } catch (e) {}
  }
  entries.sort((a, b) => String(a.joinedAt).localeCompare(String(b.joinedAt)));

  if (req.query.format === 'csv') {
    const cols = ['email', 'childName', 'childAge', 'milestone', 'source', 'joinedAt'];
    const csv = [cols.join(','), ...entries.map(e => cols.map(c => csvCell(e[c])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="launch-waitlist.csv"');
    return res.status(200).send(csv);
  }
  return res.status(200).json({ count: entries.length, entries });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      return await exportLaunchList(req, res);
    } catch (err) {
      console.error('waitlist export error:', err.message);
      return res.status(500).json({ error: 'Server error' });
    }
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, list } = req.body || {};
  const cleanEmail = String(email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    if (list === 'launch') {
      const { childName, childAge, milestone, source } = req.body;
      const age = parseInt(childAge, 10);
      const entry = {
        email: cleanEmail,
        childName: String(childName || '').trim().slice(0, 40),
        childAge: age >= 0 && age <= 18 ? age : '',
        milestone: MILESTONES.includes(milestone) ? milestone : '',
        source: String(source || '').trim().slice(0, 40),
        joinedAt: new Date().toISOString(),
      };
      // Keyed by email, so signing up twice updates the entry instead of duplicating it.
      await redisRequest('HSET', [LAUNCH_KEY, cleanEmail, JSON.stringify(entry)]);
      return res.status(200).json({ ok: true });
    }

    // RPUSH appends to a Redis list; SADD would deduplicate but list preserves order
    await redisRequest('SADD', ['intl-waitlist', cleanEmail]);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('waitlist error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
