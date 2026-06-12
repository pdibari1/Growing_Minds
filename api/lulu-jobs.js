// api/lulu-jobs.js — Lulu diagnostic + test endpoint
// Requires ?secret=ADMIN_WEBHOOK_SECRET in the query string
//
// Actions:
//   ?action=costs        (default) — print cost table across packages and page counts
//   ?action=test-order&storyId=story_XXX — create a real Lulu print job from a past story
//   ?action=job-status&jobId=123 — check status of an existing Lulu print job

const https = require("https");
const { luluRequest, createLuluPrintJob, getCoverDimensions, POD_PACKAGE_ID } = require("./lulu");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const { put } = require("@vercel/blob");

// ── Redis helper ──
async function redisGet(key) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const payload = JSON.stringify(["GET", key]);
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname, port: 443, path: "/", method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 8000
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body).result); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => resolve(null));
    req.write(payload);
    req.end();
  });
}

// ── Fetch bytes from a URL ──
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

// ── Page count estimates ──
const PAGE_COUNTS = {
  small:  { label: "Age ≤5 (15 chapters)",  pages: 90  },
  medium: { label: "Age 6–9 (20 chapters)", pages: 120 },
  large:  { label: "Age 10+ (30 chapters)", pages: 170 },
};

const PACKAGES = {
  "BW Standard":    "0550X0850.BW.STD.PB.060UW444.MXX",   // rejected — ink coverage
  "BW Premium":     "0550X0850.BW.PRE.PB.060UW444.MXX",   // rejected — ink coverage
  "Color Standard": "0550X0850.FC.STD.PB.080CW444.MXX",   // ✓ ACTIVE
  "Color Premium":  "0550X0850.FC.PRE.PB.080CW444.MXX",
};

async function getCost(podPackageId, pageCount) {
  try {
    const result = await luluRequest("POST", "/print-job-cost-calculations/", {
      line_items: [{ pod_package_id: podPackageId, quantity: 1, page_count: pageCount }],
      shipping_option_level: "GROUND",
      currency: "USD",
      shipping_address: {
        street1: "123 Main St",
        city: "San Francisco",
        state_code: "CA",
        country_code: "US",
        postcode: "94105",
      },
    });
    const cost = result?.line_item_costs?.[0];
    return cost
      ? `$${parseFloat(cost.cost_excl_discounts).toFixed(2)} + $${parseFloat(result.shipping_cost?.cost_excl_discounts || 0).toFixed(2)} shipping`
      : "N/A";
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// ── Build a test cover PDF for a given story ──
async function buildTestCoverPdf(storyId, childName, pageCount, coverImageUrl) {
  const { PDFDocument: PDoc, rgb: prgb, StandardFonts: SF } = { PDFDocument, rgb, StandardFonts };

  let dims;
  try {
    dims = await getCoverDimensions(pageCount);
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

  const coverDoc = await PDoc.create();
  const page     = coverDoc.addPage([totalW, totalH]);

  const timesRoman = await coverDoc.embedFont(SF.TimesRoman);
  const timesBold  = await coverDoc.embedFont(SF.TimesRomanBold);
  const helvetica  = await coverDoc.embedFont(SF.Helvetica);

  const green    = prgb(0.176, 0.416, 0.310);
  const gold     = prgb(0.976, 0.780, 0.310);
  const white    = prgb(1, 1, 1);
  const darkGreen = prgb(0.06, 0.15, 0.10);

  // Back cover
  page.drawRectangle({ x: 0, y: 0, width: bleedPt + trimW, height: totalH, color: darkGreen });
  page.drawText("A Growing Minds Original Story", { x: bleedPt + 24, y: totalH / 2 + 20, font: helvetica, size: 10, color: white });
  page.drawText("growingminds.io", { x: bleedPt + 24, y: bleedPt + 20, font: helvetica, size: 9, color: prgb(0.5, 0.8, 0.6) });

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
  page.drawText("A Growing Minds Original Story", { x: frontX + 24, y: bleedPt + Math.round(trimH * 0.35) - 70, font: helvetica, size: 9, color: prgb(0.8, 0.9, 0.85) });

  const pdfBytes = await coverDoc.save();
  const blob = await put(`covers/${storyId}/lulu-cover-test.pdf`, pdfBytes, { access: "public", contentType: "application/pdf" });
  console.log(`Test cover PDF built: ${blob.url} (spine ${spineW}pt)`);
  return blob.url;
}

module.exports = async function handler(req, res) {
  const secret = req.query.secret;
  if (!secret || secret !== process.env.ADMIN_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const action = req.query.action || "costs";

  try {
    // ── ACTION: costs ──
    if (action === "costs") {
      const sandbox = process.env.LULU_SANDBOX === "true";
      const costs = {};
      for (const [, tier] of Object.entries(PAGE_COUNTS)) {
        costs[tier.label] = {};
        for (const [pkgName, pkgId] of Object.entries(PACKAGES)) {
          costs[tier.label][pkgName] = await getCost(pkgId, tier.pages);
        }
      }
      return res.status(200).json({ sandbox, costs });
    }

    // ── ACTION: job-status ──
    if (action === "job-status") {
      const { jobId } = req.query;
      if (!jobId) return res.status(400).json({ error: "jobId required" });
      const status = await luluRequest("GET", `/print-jobs/${jobId}/status/`);
      return res.status(200).json({ jobId, status });
    }

    // ── ACTION: test-order ──
    if (action === "test-order") {
      const { storyId } = req.query;
      if (!storyId) return res.status(400).json({ error: "storyId required" });

      // Fetch full-book PDF URL from Redis
      const interiorUrl = await redisGet(`fullbookurl:${storyId}`);
      if (!interiorUrl) {
        return res.status(404).json({
          error: "Full-book PDF URL not found in Redis for this storyId.",
          hint: "Run a full upgrade flow first — the URL is stored after the PDF is built.",
        });
      }

      // Fetch cover image URL from Redis (optional — cover will still build without it)
      const coverImageUrl = await redisGet(`cover:${storyId}`);
      const childName = await redisGet(`childname:${storyId}`) || "Test Child";

      // Count pages in the interior PDF
      let pageCount = 120; // fallback
      try {
        const pdfBytes = await fetchBytes(interiorUrl);
        const doc = await PDFDocument.load(pdfBytes);
        pageCount = doc.getPageCount();
      } catch(e) { console.warn("Page count failed:", e.message); }

      // Build cover PDF
      const coverUrl = await buildTestCoverPdf(storyId, childName, pageCount, coverImageUrl);
      if (!coverUrl) return res.status(500).json({ error: "Cover PDF build failed" });

      // Create the Lulu print job with a test shipping address
      const job = await createLuluPrintJob({
        interiorUrl,
        coverUrl,
        shippingDetails: {
          name: "Growing Minds Test",
          address: {
            line1: "123 Main St",
            city:  "San Francisco",
            state: "CA",
            postal_code: "94105",
            country: "US",
          },
          phone: "415-555-0100",
        },
        customerEmail: process.env.LULU_CONTACT_EMAIL || "hello@growingminds.io",
        storyId: `${storyId}-test`,
        childName,
      });

      return res.status(200).json({
        success: true,
        luluJobId: job.id,
        luluStatus: job.status,
        pageCount,
        interiorUrl,
        coverUrl,
        note: "This is a REAL Lulu order — it will be charged and printed unless cancelled on lulu.com",
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}. Use costs, job-status, or test-order.` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
