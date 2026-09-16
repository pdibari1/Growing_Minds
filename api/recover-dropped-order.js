// api/recover-dropped-order.js — Manual recovery for a paid order that never reached
// Inngest because its storyToken had already expired out of Redis (see the 24h→30d
// TTL fix in generate-preview.js — this endpoint exists for orders dropped *before*
// that fix, or any future case where the token is otherwise unrecoverable from Redis).
//
// Reconstructs a storyToken from admin-supplied intake fields (pulled from the Stripe
// checkout session / customer correspondence / re-asking the customer) and fires the
// same Inngest event webhook.js would have fired, so the order runs through the normal
// pipeline from here.
//
// Usage: POST /api/recover-dropped-order?secret=ADMIN_WEBHOOK_SECRET
// Body: {
//   storyId, childName, customerEmail,
//   paymentType: "full" | "upgrade" | "preview",
//   name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend,
//   city, region, milestone, genre, genreStyle,
//   customDetails  // optional — free-text milestone/appearance answers
// }

const https = require("https");
const { Resend } = require("resend");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secret = req.query.secret;
  if (!secret || secret !== process.env.ADMIN_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const {
    storyId, childName, customerEmail, paymentType,
    name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend,
    city, region, milestone, genre, genreStyle, customDetails
  } = req.body || {};

  const missing = ["storyId", "childName", "customerEmail", "paymentType", "name", "age", "city", "region", "milestone"]
    .filter(f => !req.body?.[f]);
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
  }
  if (!["full", "upgrade", "preview"].includes(paymentType)) {
    return res.status(400).json({ error: `paymentType must be "full", "upgrade", or "preview"` });
  }

  try {
    // Reconstruct the exact storyToken shape generate-preview.js originally created.
    const storyToken = Buffer.from(JSON.stringify({
      name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend,
      city, region, milestone, storyId, genre, genreStyle
    })).toString("base64url");

    // Re-save to Redis (30-day TTL, matching the normal path) so later retries or an
    // upgrade-from-this-preview can still find it, same as the original flow.
    await redisSet(`token:${storyId}`, storyToken, 2592000);
    if (customDetails) {
      await redisSet(`customdetails:${storyId}`, customDetails, 2592000);
    }

    const eventName = paymentType === "preview" ? "story/preview.purchased" : "order/completed";
    await sendInngestEvent({
      name: eventName,
      data: { storyToken, childName, storyId, customerEmail, customDetails: customDetails || "" }
    });

    console.log(`Manually recovered dropped order: ${eventName} sent for ${childName} (${storyId})`);

    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
        to: process.env.ADMIN_ALERT_EMAIL || "hello@growingminds.io",
        subject: `🔧 Manually recovered order — ${childName} (${storyId})`,
        text: `A dropped order was manually recovered and re-queued to Inngest.\n\nstoryId: ${storyId}\nchildName: ${childName}\ncustomerEmail: ${customerEmail}\npaymentType: ${paymentType}\nevent: ${eventName}`
      });
    } catch (e) {
      console.error("Recovery confirmation email failed:", e.message);
    }

    return res.status(200).json({ ok: true, event: eventName, storyId });
  } catch (err) {
    console.error("[recover-dropped-order] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

function redisSet(key, value, exSeconds) {
  return new Promise((resolve) => {
    const options = {
      hostname: new URL(process.env.UPSTASH_REDIS_REST_URL).hostname,
      port: 443,
      path: "/",
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    };
    const payload = JSON.stringify(["SET", key, value, "EX", String(exSeconds)]);
    const request = https.request(options, (r) => {
      let body = "";
      r.on("data", chunk => body += chunk);
      r.on("end", () => resolve(body));
    });
    request.on("error", () => resolve(null));
    request.write(payload);
    request.end();
  });
}

function sendInngestEvent(event) {
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
