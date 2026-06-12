// api/remake-images.js — Admin clicks "Remake Images" in the Lulu approval email
// Fires images/remake which triggers the remakeStoryImages Inngest function.
// That function re-generates all illustrations, rebuilds the full-book PDF,
// and sends a fresh Lulu approval email when done.
// The original generateRemainingChapters run keeps waiting for lulu/approved throughout.
const crypto = require("crypto");
const https  = require("https");

function adminToken(storyId) {
  return crypto
    .createHmac("sha256", process.env.ADMIN_WEBHOOK_SECRET || "dev-secret")
    .update(storyId)
    .digest("hex")
    .slice(0, 24);
}

function sendInngestEvent(event) {
  const payload  = JSON.stringify(event);
  const eventKey = process.env.INNGEST_EVENT_KEY;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "inn.gs", port: 443,
      path: "/e/" + eventKey,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 10000,
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Inngest timeout")));
    req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  const { storyId, token } = req.query;

  if (!storyId || !token) return res.status(400).send("Missing storyId or token");
  if (token !== adminToken(storyId)) return res.status(403).send("Invalid token");

  try {
    await sendInngestEvent({ name: "images/remake", data: { storyId } });

    return res.status(200).send(`
      <html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#1a1a2e;">
        <div style="font-size:2.5rem;margin-bottom:1rem;">🔄</div>
        <h2 style="color:#2d6a4f;">Remaking images…</h2>
        <p style="color:#6b7280;">All illustrations are being regenerated. This takes about 10–15 minutes. You'll receive a new Lulu approval email when they're ready.</p>
        <p style="color:#9ca3af;font-size:.85rem;margin-top:1rem;">Story ID: <code>${storyId}</code></p>
      </body></html>
    `);
  } catch (err) {
    console.error("Remake-images error:", err.message);
    return res.status(500).send("Failed to start remake — check Inngest logs");
  }
};
