// api/approve-lulu.js — Admin clicks "Send to Lulu" in the Lulu approval email
// Fires lulu/approved which unblocks the waiting generateRemainingChapters run
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
    await sendInngestEvent({ name: "lulu/approved", data: { storyId } });

    return res.status(200).send(`
      <html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#1a1a2e;">
        <div style="font-size:2.5rem;margin-bottom:1rem;">📦</div>
        <h2 style="color:#16a34a;">Sent to Lulu!</h2>
        <p style="color:#6b7280;">The print job is being submitted now. You'll see it appear in your Lulu dashboard within a minute.</p>
        <p style="color:#9ca3af;font-size:.85rem;margin-top:1rem;">Story ID: <code>${storyId}</code></p>
      </body></html>
    `);
  } catch (err) {
    console.error("Approve-lulu error:", err.message);
    return res.status(500).send("Failed to approve — check Inngest logs");
  }
};
