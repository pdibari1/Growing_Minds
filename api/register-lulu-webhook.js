// api/register-lulu-webhook.js — one-time admin endpoint to register the
// PRINT_JOB_STATUS_CHANGED webhook with Lulu, so api/lulu-webhook.js starts
// receiving print status events (needed for the customer shipping-tracking
// email). This only needs to run once per Lulu account/environment — sandbox
// and live use separate registrations, so re-run after flipping LULU_SANDBOX.
//
// Usage: POST /api/register-lulu-webhook?secret=ADMIN_WEBHOOK_SECRET
// Body (optional): { "webhookUrl": "https://growingminds.io/api/lulu-webhook" }

const { registerLuluWebhook } = require("./lulu");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secret = req.query.secret;
  if (!secret || secret !== process.env.ADMIN_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const webhookUrl = req.body?.webhookUrl || "https://growingminds.io/api/lulu-webhook";

  try {
    const result = await registerLuluWebhook(webhookUrl);
    console.log(`Lulu webhook registered: ${webhookUrl}`, JSON.stringify(result));
    return res.status(200).json({ ok: true, webhookUrl, result });
  } catch (err) {
    console.error("[register-lulu-webhook] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
