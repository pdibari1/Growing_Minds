// api/capture-email.js — saves email to Airtable early in the funnel
const https = require("https");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { email, childName, childAge, priorStoryId } = req.body;
  if (!email) return res.status(400).json({ error: "No email" });

  try {
    await saveToAirtable(email, childName, childAge, priorStoryId);
    return res.status(200).json({ ok: true });
  } catch(err) {
    console.error("Airtable capture error:", err.message);
    return res.status(200).json({ ok: false }); // never block the user
  }
};

function saveToAirtable(email, childName, childAge, priorStoryId) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const token  = process.env.AIRTABLE_TOKEN;
  if (!baseId || !token) return Promise.resolve();

  const fields = {
    "Email":      email,
    "Child Name": childName || "",
    "Child Age":  parseInt(childAge) || 0,
    "Created At": new Date().toISOString().split("T")[0]
  };
  if (priorStoryId) fields["Prior Story ID"] = priorStoryId;

  const payload = JSON.stringify({ records: [{ fields }] });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.airtable.com",
      port: 443,
      path: `/v0/${baseId}/Leads`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        console.log(`Airtable ${res.statusCode}: ${body.slice(0, 80)}`);
        resolve();
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
