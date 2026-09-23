// api/lulu.js — Lulu Print API helper (auth + print job creation)
// Docs: https://api.lulu.com/docs/
// SKU format: [Trim].[Ink].[Quality].[Binding].[Paper].[Finish]

const https = require("https");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const { put } = require("@vercel/blob");

// Set LULU_SANDBOX=true in Vercel env vars to use the sandbox (no real prints, no charges)
const SANDBOX     = process.env.LULU_SANDBOX === "true";
const LULU_BASE   = SANDBOX ? "api.sandbox.lulu.com" : "api.lulu.com";
const LULU_TOKEN_PATH = "/auth/realms/glasstree/protocol/openid-connect/token";

if (SANDBOX) console.log("[lulu] ⚠️  SANDBOX MODE — orders will not be printed or charged");

// 5.5" × 8.5" | Full Color | Perfect Bound | 80# Coated White | Matte cover
// Confirmed via /api/lulu-cost-check — premium quotes ~$22.83 print cost vs
// standard's ~$9.57 for the same 150-page book, so this is a real distinct tier,
// not a guess that happened to validate.
const POD_PACKAGE_IDS = {
  standard: "0550X0850.FC.STD.PB.080CW444.MXX",
  premium: "0550X0850.FC.PRE.PB.080CW444.MXX",
};
// Kept for any existing caller that doesn't pass printQuality.
const POD_PACKAGE_ID = POD_PACKAGE_IDS.standard;

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
async function getCoverDimensions(pageCount, printQuality = "standard") {
  const podPackageId = POD_PACKAGE_IDS[printQuality] || POD_PACKAGE_IDS.standard;
  const result = await luluRequest("POST", "/print-jobs/cover-dimensions/", {
    pod_package_id: podPackageId,
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
// printQuality    — 'standard' | 'premium', selects the POD package (see POD_PACKAGE_IDS)
async function createLuluPrintJob({ interiorUrl, coverUrl, shippingDetails, customerEmail, storyId, childName, printQuality = "standard" }) {
  const addr = shippingDetails?.address || {};
  const name = shippingDetails?.name || childName;
  const podPackageId = POD_PACKAGE_IDS[printQuality] || POD_PACKAGE_IDS.standard;

  const job = await luluRequest("POST", "/print-jobs/", {
    external_id: storyId,
    contact_email: process.env.LULU_CONTACT_EMAIL || "hello@growingminds.io",
    // Confirmed via /api/lulu-cost-check: "GROUND" is not a valid shipping option
    // for this package/US destination combo (Lulu 400s: "No shipping option found
    // for GROUND to US..."). "MAIL" is. This was never caught before because the
    // print pipeline has never actually been exercised end-to-end.
    shipping_option: "MAIL",  // API field is shipping_option, not shipping_level
    line_items: [{
      title: `${childName}'s Personalized Story Book`,
      cover: { source_url: coverUrl },
      interior: { source_url: interiorUrl },
      pod_package_id: podPackageId,
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

// ── Fetch raw bytes from a URL (follows redirects) ──
function fetchBytes(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === "https:" ? https : require("http");
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBytes(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
  });
}

// ── Build a print-ready cover PDF (front + spine + back, with bleed) ──
// Lulu needs one flat cover PDF sized to its own cover-dimensions formula, not the
// per-chapter interior PDF's cover page — spine width depends on final page count,
// so this can only be built once the interior PDF is finished. Adapted from the
// same drawing logic already proven out in api/lulu-jobs.js's admin test-order path.
async function buildCoverPdf(storyId, childName, pageCount, coverImageUrl, printQuality = "standard") {
  let dims;
  try {
    dims = await getCoverDimensions(pageCount, printQuality);
  } catch(e) {
    console.warn(`getCoverDimensions failed: ${e.message} — using formula`);
    const spineIn = pageCount / 444;
    dims = { width: String(5.5 * 2 + spineIn + 0.125 * 2), height: String(8.5 + 0.125 * 2) };
  }

  const coverWidthIn  = parseFloat(dims.width);
  const coverHeightIn = parseFloat(dims.height);
  const spineIn = Math.max(0, coverWidthIn - (5.5 * 2 + 0.125 * 2));
  const totalW  = Math.round(coverWidthIn  * 72);
  const totalH  = Math.round(coverHeightIn * 72);
  const spineW  = Math.round(spineIn * 72);
  const bleedPt = Math.round(0.125 * 72);
  const trimW   = Math.round(5.5 * 72);
  const trimH   = Math.round(8.5 * 72);

  const coverDoc = await PDFDocument.create();
  const page     = coverDoc.addPage([totalW, totalH]);

  const timesBold = await coverDoc.embedFont(StandardFonts.TimesRomanBold);
  const helvetica = await coverDoc.embedFont(StandardFonts.Helvetica);

  const green     = rgb(0.176, 0.416, 0.310);
  const white     = rgb(1, 1, 1);
  const darkGreen = rgb(0.06, 0.15, 0.10);

  // Back cover
  page.drawRectangle({ x: 0, y: 0, width: bleedPt + trimW, height: totalH, color: darkGreen });
  page.drawText("A Growing Minds Original Story", { x: bleedPt + 24, y: totalH / 2 + 20, font: helvetica, size: 10, color: white });
  page.drawText("growingminds.io", { x: bleedPt + 24, y: bleedPt + 20, font: helvetica, size: 9, color: rgb(0.5, 0.8, 0.6) });

  // Spine
  const spineX = bleedPt + trimW;
  page.drawRectangle({ x: spineX, y: 0, width: spineW, height: totalH, color: green });
  if (spineW > 30) {
    page.drawText(`${childName} · Growing Minds`, {
      x: spineX + spineW / 2 + 6, y: bleedPt + 20,
      font: timesBold, size: Math.min(9, spineW * 0.4), color: white,
      rotate: { type: "degrees", angle: 90 },
    });
  }

  // Front cover
  const frontX = spineX + spineW;
  page.drawRectangle({ x: frontX, y: 0, width: trimW + bleedPt, height: totalH, color: darkGreen });

  if (coverImageUrl) {
    try {
      const imgBytes = await fetchBytes(coverImageUrl);
      const img = await coverDoc.embedJpg(imgBytes).catch(() => coverDoc.embedPng(imgBytes));
      page.drawImage(img, { x: frontX, y: bleedPt + Math.round(trimH * 0.35), width: trimW, height: Math.round(trimH * 0.65) });
    } catch(e) { console.warn("Cover image embed failed:", e.message); }
  }

  page.drawRectangle({ x: frontX, y: bleedPt, width: trimW, height: Math.round(trimH * 0.38), color: green });
  page.drawText(`${childName}'s Story`, { x: frontX + 24, y: bleedPt + Math.round(trimH * 0.35) - 40, font: timesBold, size: 22, color: white });
  page.drawText("A Growing Minds Original Story", { x: frontX + 24, y: bleedPt + Math.round(trimH * 0.35) - 70, font: helvetica, size: 9, color: rgb(0.8, 0.9, 0.85) });

  const pdfBytes = await coverDoc.save();
  const blob = await put(`covers/${storyId}/lulu-cover.pdf`, pdfBytes, { access: "public", contentType: "application/pdf" });
  console.log(`Lulu cover PDF built: ${blob.url} (spine ${spineW}pt)`);
  return blob.url;
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
  POD_PACKAGE_IDS,
  getLuluToken,
  luluRequest,
  getCoverDimensions,
  createLuluPrintJob,
  getLuluJobStatus,
  registerLuluWebhook,
  buildCoverPdf,
};
