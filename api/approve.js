// api/approve.js — Admin clicks "Send Now" in the notification email
const crypto = require("crypto");
const https = require("https");

function adminToken(storyId) {
  return crypto
    .createHmac("sha256", process.env.ADMIN_WEBHOOK_SECRET || "dev-secret")
    .update(storyId)
    .digest("hex")
    .slice(0, 24);
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
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
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

  if (!storyId || !token) {
    return res.status(400).send("Missing storyId or token");
  }

  if (token !== adminToken(storyId)) {
    return res.status(403).send("Invalid token");
  }

  try {
    await sendInngestEvent({
      name: "story/approved",
      data: { storyId }
    });

    return res.status(200).send(`
      <html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#1a1a2e;">
        <div style="font-size:2.5rem;margin-bottom:1rem;">✓</div>
        <h2 style="color:#16a34a;">Story approved!</h2>
        <p style="color:#6b7280;">The story is being sent to the customer now.</p>
      </body></html>
    `);
  } catch (err) {
    console.error("Approve error:", err.message);
    return res.status(500).send("Failed to approve — check Inngest logs");
  }
};
