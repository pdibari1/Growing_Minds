// api/approve-print.js — admin clicks "Approve & Send" in the book-ready review email
// Fires book/approved, which unblocks generateStoryOrder's step.waitForEvent gate —
// only then does the print job go to Lulu.
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

  if (req.method === "GET") {
    // Show a confirmation page instead of approving immediately. Email
    // security scanners and some email clients pre-fetch every link in a
    // message to check it for malware — without this, that automated
    // pre-fetch would silently approve and submit a real, chargeable print
    // job to Lulu before a human ever actually clicked anything.
    return res.status(200).send(`
      <html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#1a1a2e;">
        <h2>Approve &amp; send this book?</h2>
        <p style="color:#6b7280;">This submits a real, chargeable print job to Lulu and emails the customer their book — there's no confirmation step after this.</p>
        <form method="POST" action="/api/approve-print?storyId=${encodeURIComponent(storyId)}&token=${encodeURIComponent(token)}">
          <button type="submit" style="background:#16a34a;color:#fff;border:none;padding:1rem 2rem;border-radius:999px;font-size:1rem;font-weight:700;cursor:pointer;">✓ Yes, Approve &amp; Send</button>
        </form>
      </body></html>
    `);
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  try {
    await sendInngestEvent({
      name: "book/approved",
      data: { storyId }
    });

    return res.status(200).send(`
      <html><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#1a1a2e;">
        <div style="font-size:2.5rem;margin-bottom:1rem;">✓</div>
        <h2 style="color:#16a34a;">Book approved!</h2>
        <p style="color:#6b7280;">The print job is being submitted to Lulu. The customer will get a tracking email when it ships.</p>
      </body></html>
    `);
  } catch (err) {
    console.error("Approve-print error:", err.message);
    return res.status(500).send("Failed to approve — check Inngest logs");
  }
};
