// api/webhook.js — verifies Stripe, sends event to Inngest
const Stripe = require("stripe");
const https = require("https");

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
  const { storyToken, childName, storyId, customDetails } = session.metadata;
  const customerEmail = session.customer_details?.email;

  console.log(`Order received for ${childName} — sending to Inngest`);

  // Send event to Inngest
  await sendInngestEvent({
    name: "order/completed",
    data: { storyToken, childName, storyId, customerEmail, customDetails: customDetails || '' }
  });

  console.log(`Inngest event sent for ${childName}`);
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
