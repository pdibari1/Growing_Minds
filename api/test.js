// api/test.js — temporary diagnostic endpoint
const https = require("https");

module.exports = async function handler(req, res) {
  console.log("Test endpoint called");
  
  return new Promise((resolve) => {
    const options = {
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      timeout: 15000
    };

    const payload = JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "Say hi" }]
    });

    options.headers["Content-Length"] = Buffer.byteLength(payload);

    console.log("Making request to Anthropic...");

    const req2 = https.request(options, (r) => {
      let body = "";
      r.on("data", chunk => body += chunk);
      r.on("end", () => {
        console.log("Anthropic responded:", r.statusCode, body);
        res.status(200).json({ status: r.statusCode, body: JSON.parse(body) });
        resolve();
      });
    });

    req2.on("error", (err) => {
      console.error("Request error:", err.message);
      res.status(500).json({ error: err.message });
      resolve();
    });

    req2.on("timeout", () => {
      console.error("Request timed out");
      res.status(500).json({ error: "timeout" });
      req2.destroy();
      resolve();
    });

    req2.write(payload);
    req2.end();
  });
};
