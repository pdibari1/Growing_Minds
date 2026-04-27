// api/webhook.js — verifies Stripe, sends event to Inngest
const Stripe = require("stripe");
const https = require("https");

// ── Redis (Upstash REST) — retrieves storyToken stored by generate-preview.js ──
async function redisGet(key) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const payload = JSON.stringify(["GET", key]);
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname, port: 443, path: "/",
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 8000
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => { try { resolve(JSON.parse(body).result); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => resolve(null));
    req.write(payload);
    req.end();
  });
}

module.exports.config = { api: { bodyParser: false } };

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig  = req.headers["stripe-signature"];
  const body = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const { childName, storyId, customDetails, payment_type } = session.metadata;
  const customerEmail = session.customer_details?.email;

  // ── UPGRADE payment — customer already has chapters 1-3, now wants the full book ──
  if (payment_type === 'upgrade') {
    console.log(`Upgrade payment received for ${childName} (${storyId}) — sending to Inngest`);
    await sendInngestEvent({
      name: "upgrade/completed",
      data: { storyId, childName, customerEmail, shippingAddress: session.shipping_details || null }
    });
    return res.status(200).json({ received: true });
  }

  // ── PREVIEW payment — generate chapters 1-3 and email them ──
  // ── FULL payment (no payment_type) — generate complete book (legacy / direct purchase) ──
  let storyToken = await redisGet(`token:${storyId}`);
  if (!storyToken && session.metadata.storyToken) {
    storyToken = session.metadata.storyToken;
    console.log(`storyToken retrieved from Stripe metadata fallback for ${storyId}`);
  }

  if (!storyToken) {
    console.error(`FATAL: No storyToken found for storyId ${storyId} (childName: ${childName}). Order not queued.`);
    return res.status(200).json({ received: true, error: "missing_token" });
  }

  if (payment_type === 'preview') {
    console.log(`Preview payment received for ${childName} — sending to Inngest`);
    await sendInngestEvent({
      name: "preview/completed",
      data: { storyToken, childName, storyId, customerEmail, customDetails: customDetails || '' }
    });
  } else {
    console.log(`Full order received for ${childName} — sending to Inngest`);
    await sendInngestEvent({
      name: "order/completed",
      data: { storyToken, childName, storyId, customerEmail, customDetails: customDetails || '' }
    });
  }

  return res.status(200).json({ received: true });
};

async function sendInngestEvent(event) {
  const payload = JSON.stringify(event);
  const eventKey = process.env.INNGEST_EVENT_KEY;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "inn.gs",
      port: 443,
      path: "/e/" + eventKey,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: 10000
    };

    const req = https.request(options, (r) => {
      let body = "";
      r.on("data", chunk => body += chunk);
      r.on("end", () => {
        console.log(`Inngest response: ${r.statusCode} — ${body}`);
        resolve();
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Inngest timeout")));
    req.write(payload);
    req.end();
  });
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
