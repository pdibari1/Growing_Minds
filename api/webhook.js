// api/webhook.js — verifies Stripe, sends event to Inngest
const Stripe = require("stripe");
const https = require("https");
const { Resend } = require("resend");

// A paid order silently dropped here (missing token, Inngest unreachable) means a
// customer paid and got nothing, with no trace anywhere but a Vercel log line.
async function sendAlertEmail(subject, details) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
      to: process.env.ADMIN_ALERT_EMAIL || "hello@growingminds.io",
      subject: `⚠️ ${subject}`,
      text: details
    });
  } catch (e) {
    console.error(`Alert email failed to send: ${e.message}`);
  }
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
  const { storyId, childName, customDetails: metaCustomDetails, payment_type } = session.metadata;
  const customerEmail = session.customer_details?.email;

  // Get storyToken from Redis
  const storyToken = await getTokenFromRedis(storyId);
  if (!storyToken) {
    console.error(`FATAL: No storyToken found for storyId ${storyId} (childName: ${childName}). Order not queued.`);
    await sendAlertEmail(
      `Order dropped — no storyToken for ${childName} (${storyId})`,
      `A ${payment_type || 'unknown'}-type Stripe payment completed for ${childName} (storyId ${storyId}, ${customerEmail || 'no email'}) but no storyToken was found in Redis, so the order was never sent to Inngest. The customer paid and got nothing queued.`
    );
    return res.status(200).json({ received: true });
  }

  const isPreview = payment_type === 'preview';
  const eventName = isPreview ? 'story/preview.purchased' : 'order/completed';

  console.log(`Raw token first 20: ${storyToken?.slice(0,20)}`); console.log(`${isPreview ? 'Preview' : 'Full'} order received for ${childName} — sending to Inngest`);

  // Stripe metadata caps each value at 500 characters, so customDetails there is
  // truncated. The full text lives in Redis (saved by generate-preview.js) — use
  // that, falling back to the truncated metadata copy only if it's gone.
  const fullCustomDetails = await getCustomDetailsFromRedis(storyId);
  const customDetails = fullCustomDetails || metaCustomDetails || '';

  try {
    await sendInngestEvent({
      name: eventName,
      data: { storyToken, childName, storyId, customerEmail, customDetails }
    });
  } catch (e) {
    console.error(`Failed to send Inngest event for ${childName}: ${e.message}`);
    await sendAlertEmail(
      `Order dropped — Inngest event failed for ${childName} (${storyId})`,
      `sendInngestEvent threw: ${e.message}\n\nA ${payment_type || 'unknown'}-type Stripe payment completed for ${childName} (storyId ${storyId}) but the Inngest event failed to send.`
    );
    // Non-2xx so Stripe retries this webhook delivery on its own schedule.
    return res.status(500).json({ error: "Failed to queue order" });
  }

  console.log(`Inngest event sent for ${childName}: ${eventName}`);
  return res.status(200).json({ received: true });
};

async function getTokenFromRedis(storyId) {
  return new Promise((resolve) => {
    const options = {
      hostname: new URL(process.env.UPSTASH_REDIS_REST_URL).hostname,
      port: 443,
      path: `/get/token:${storyId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          let result = parsed.result || null; console.log('Redis raw result type:', typeof result, 'isArray:', Array.isArray(result), 'val:', JSON.stringify(result)?.slice(0,50)); if (Array.isArray(result)) result = result[0] || null;
          if (result && result.startsWith('"') && result.endsWith('"')) {
            result = result.slice(1, -1);
          }
          console.log(`Token for ${storyId}: ${result ? `found (${result.length} chars)` : 'NOT FOUND'}`);
          resolve(result);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function getCustomDetailsFromRedis(storyId) {
  return new Promise((resolve) => {
    const options = {
      hostname: new URL(process.env.UPSTASH_REDIS_REST_URL).hostname,
      port: 443,
      path: `/get/customdetails:${storyId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          let result = parsed.result || null;
          if (Array.isArray(result)) result = result[0] || null;
          if (result && result.startsWith('"') && result.endsWith('"')) {
            result = result.slice(1, -1);
          }
          resolve(result);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

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
