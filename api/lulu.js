// api/lulu.js — Lulu Print API helper (auth + print job creation)
// Docs: https://api.lulu.com/docs/
// SKU format: [Trim].[Ink].[Quality].[Binding].[Paper].[Finish]

const https = require("https");

// Set LULU_SANDBOX=true in Vercel env vars to use the sandbox (no real prints, no charges)
const SANDBOX     = process.env.LULU_SANDBOX === "true";
const LULU_BASE   = SANDBOX ? "api.sandbox.lulu.com" : "api.lulu.com";
const LULU_TOKEN_PATH = "/auth/realms/glasstree/protocol/openid-connect/token";

if (SANDBOX) console.log("[lulu] ⚠️  SANDBOX MODE — orders will not be printed or charged");

// 5.5" × 8.5" | Full Color | Standard | Perfect Bound | 80# Coated White | Matte cover
const POD_PACKAGE_ID = "0550X0850.FC.STD.PB.080CW444.MXX";

// ── Token cache (in-process; refreshes when < 60s remain) ──
let _token = null;
let _tokenExpires = 0;

async function getLuluToken() {
  if (_token && Date.now() < _tokenExpires - 60_000) return _token;

  const clientId     = process.env.LULU_CLIENT_ID;
  const clientSecret = process.env.LULU_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("LULU_CLIENT_ID / LULU_CLIENT_SECRET not set");

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = "grant_type=client_credentials";

  const data = await httpsRequest({
    hostname: LULU_BASE,
    path: LULU_TOKEN_PATH,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);

  _token = data.access_token;
  _tokenExpires = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}

// ── Generic authenticated request ──
async function luluRequest(method, path, body = null) {
  const token = await getLuluToken();
  const payload = body ? JSON.stringify(body) : null;
  return httpsRequest({
    hostname: LULU_BASE,
    path,
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
    },
  }, payload);
}

// ── Get cover dimensions for a given page count ──
// Returns { width, height, unit } — Lulu total cover size including bleed, in inches.
// Spine must be derived: spine = width - (5.5*2 + 0.125*2) for 5.5" trim with 0.125" bleed.
async function getCoverDimensions(pageCount) {
  const result = await luluRequest("POST", "/print-jobs/cover-dimensions/", {
    pod_package_id: POD_PACKAGE_ID,
    interior_page_count: pageCount,
    unit: "inch",   // must be lowercase — Lulu enum: pt | mm | inch
  });
  return result;
}

// ── Create a Lulu print job ──
// interiorUrl  — public URL to the interior PDF (must be 5.5×8.5", fonts embedded)
// coverUrl     — public URL to the cover PDF (front+spine+back, with bleed)
// shippingDetails — Stripe shipping_details object { name, address: { line1, line2, city, state, postal_code, country } }
// customerEmail   — contact email for the job
// storyId         — used as external_id for reference
async function createLuluPrintJob({ interiorUrl, coverUrl, shippingDetails, customerEmail, storyId, childName }) {
  const addr = shippingDetails?.address || {};
  const name = shippingDetails?.name || childName;

  const job = await luluRequest("POST", "/print-jobs/", {
    external_id: storyId,
    contact_email: process.env.LULU_CONTACT_EMAIL || "hello@growingminds.io",
    shipping_option: "GROUND",  // API field is shipping_option, not shipping_level
    line_items: [{
      title: `${childName}'s Personalized Story Book`,
      cover: { source_url: coverUrl },
      interior: { source_url: interiorUrl },
      pod_package_id: POD_PACKAGE_ID,
      quantity: 1,
    }],
    shipping_address: {
      name,
      street1: addr.line1 || "",
      street2: addr.line2 || "",
      city: addr.city || "",
      state_code: addr.state || "",
      country_code: addr.country || "US",
      postcode: addr.postal_code || "",
      // Phone is required by Lulu carriers — use a default if not collected
      phone_number: shippingDetails?.phone || "0000000000",
    },
  });

  return job; // { id, status, ... }
}

// ── Get print job status ──
async function getLuluJobStatus(jobId) {
  return luluRequest("GET", `/print-jobs/${jobId}/status/`);
}

// ── Register a webhook (call once during setup, not per order) ──
async function registerLuluWebhook(webhookUrl) {
  return luluRequest("POST", "/webhooks/", {
    url: webhookUrl,
    topics: ["PRINT_JOB_STATUS_CHANGED"],
  });
}

// ── Low-level HTTPS helper ──
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Lulu API ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Lulu non-JSON response (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Lulu API timeout")));
    if (body) req.write(body);
    req.end();
  });
}

module.exports = {
  POD_PACKAGE_ID,
  getLuluToken,
  luluRequest,
  getCoverDimensions,
  createLuluPrintJob,
  getLuluJobStatus,
  registerLuluWebhook,
};
