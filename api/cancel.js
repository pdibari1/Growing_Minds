// api/cancel.js — Admin clicks "Cancel" in the notification email.
// Sets the skip-delivery flag then fires story/approved to unblock the workflow.
// The workflow wakes up, sees the skip flag, and exits without sending anything.
const crypto = require("crypto");
const https = require("https");

function adminToken(storyId) {
  return crypto
    .createHmac("sha256", process.env.ADMIN_WEBHOOK_SECRET || "dev-secret")
    .update(storyId)
    .digest("hex")
    .slice(0, 24);
}

async function redisRequest(command, args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const payload = JSON.stringify([command, ...args]);
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: "/",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(body).result); }
        catch { resolve(null); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Redis timeout")));
    req.write(payload);
    req.end();
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
    const childName = await redisRequest("GET", [`childname:${storyId}`]);

    // Mark as skip-delivery so the workflow send-email step no-ops
    await redisRequest("SET", [`skip-delivery:${storyId}`, "1", "EX", 86400]);

    // Unblock the waitForEvent — workflow will wake up, see the skip flag, and exit
    await sendInngestEvent({
      name: "story/approved",
      data: { storyId }
    });

    return res.status(200).send(`
      <html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#1a1a2e;">
        <div style="font-size:2.5rem;margin-bottom:1rem;">✕</div>
        <h2 style="color:#dc2626;">Story cancelled</h2>
        <p style="color:#6b7280;">The story for ${childName || 'this customer'} has been cancelled and will not be sent.</p>
        <p style="color:#9ca3af;font-size:.85rem;margin-top:1rem;">Story ID: <code>${storyId}</code></p>
      </body></html>
    `);
  } catch (err) {
    console.error("Cancel error:", err.message);
    return res.status(500).send("Failed to cancel — check logs");
  }
};
