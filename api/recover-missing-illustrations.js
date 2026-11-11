// api/recover-missing-illustrations.js — Admin recovery for a real order whose
// illustration generation partially failed mid-run (e.g. Gemini/AI Studio
// prepaid credits ran out mid-batch, so both the batch job AND its real-time
// fallback failed on the same images). Regenerates ONLY the still-missing
// images for an existing storyId — reusing the same character reference and
// per-chapter scene prompts the original run would have used — then rebuilds
// the full-book PDF with the now-complete set and updates fullbookurl in
// Redis, so the admin-approval email's "Approve & Send" link (already sent,
// its own PDF preview link now stale) picks up the corrected PDF once
// clicked: api/inngest.js's submit-lulu-print-job step re-reads fullbookurl
// fresh from Redis rather than trusting its own memoized value, specifically
// so this recovery path works on an order already paused at that wait.
//
// Requires the order to still have its chapters/outline in Redis — these get
// deleted by the main pipeline's "cleanup" step, which only runs AFTER the
// admin-approval wait resolves (approved or timed out). So this must run
// before that happens, not after.
//
// Usage: POST /api/recover-missing-illustrations?secret=ADMIN_WEBHOOK_SECRET
// Body: { storyId }

const { put } = require("@vercel/blob");
const { Resend } = require("resend");
const {
  getStoryTier,
  decodeStoryData,
  buildIllustrationPromptContext,
  getOrCreateCharacterReference,
  callGeminiImageWithSafeRetry,
  getIllustrationsFromRedis,
  saveIllustrationsToRedis,
  redisRequest,
  getChaptersFromRedis,
  generatePDF,
} = require("./inngest");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secret = req.query.secret;
  if (!secret || secret !== process.env.ADMIN_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { storyId } = req.body || {};
  if (!storyId) return res.status(400).json({ error: "Missing storyId" });

  try {
    const [tokenRaw, customDetails, outlineRaw, luluJobId, savedChildName] = await Promise.all([
      redisRequest("GET", [`token:${storyId}`]),
      redisRequest("GET", [`customdetails:${storyId}`]),
      redisRequest("GET", [`outline:${storyId}`]),
      redisRequest("GET", [`lulu-job:${storyId}`]),
      redisRequest("GET", [`childname:${storyId}`]),
    ]);

    if (luluJobId) {
      return res.status(409).json({
        error: `A Lulu print job (${luluJobId}) already exists for ${storyId} — this order was already approved and sent to print. Regenerating images now wouldn't reach whatever was already printed; handle this one manually, not through this endpoint.`
      });
    }
    if (!tokenRaw) return res.status(404).json({ error: `No token:${storyId} in Redis — can't reconstruct intake data (or the order's already past the cleanup step)` });
    if (!outlineRaw) return res.status(404).json({ error: `No outline:${storyId} in Redis` });

    const childData = decodeStoryData(tokenRaw);
    if (!childData) return res.status(500).json({ error: "Failed to decode storyToken" });
    if (customDetails) childData.customDetails = customDetails;

    const outline = JSON.parse(outlineRaw);
    const tier = getStoryTier(childData.age);
    const imagesPerChap = tier.imagesPerChap || 1;

    const expectedKeys = ['0-0'];
    for (let ci = 1; ci < outline.length; ci++) {
      for (let sub = 0; sub < imagesPerChap; sub++) expectedKeys.push(`${ci}-${sub}`);
    }

    const existing = await getIllustrationsFromRedis(storyId);
    const missingKeys = expectedKeys.filter((k) => !existing[k]);

    if (missingKeys.includes('0-0')) {
      return res.status(409).json({ error: "Cover (0-0) is missing — this needs the full pipeline re-run, not a targeted recovery (the cover anchors the character reference everything else is generated against)." });
    }

    let recovered = 0;
    const failures = [];

    if (missingKeys.length > 0) {
      const promptCtx = buildIllustrationPromptContext(childData, outline, tier);
      const referenceBytes = await getOrCreateCharacterReference(storyId, promptCtx.referencePrompt);

      const result = {};
      for (const key of missingKeys) {
        try {
          const { scenePrompt, fallbackScenePrompt } = promptCtx.buildScene(key);
          const gen = await callGeminiImageWithSafeRetry(referenceBytes, scenePrompt, fallbackScenePrompt, { aspectRatio: "4:3", imageSize: "2K" });
          const blob = await put(`illustrations/${storyId}/${key}.png`, gen.bytes, { access: 'public', contentType: 'image/png' });
          result[key] = blob.url;
          console.log(`Recovered image ${key} for ${storyId}`);
        } catch (err) {
          console.error(`Recovery failed for ${key}: ${err.message}`);
          failures.push({ key, error: err.message });
        }
      }
      if (Object.keys(result).length) await saveIllustrationsToRedis(storyId, result);
      recovered = Object.keys(result).length;
    }

    // Rebuild the full PDF with whatever's now the complete (or best-available)
    // set of illustrations — the original PDF was built once, before this
    // recovery, and won't update itself.
    const finalIllustrations = await getIllustrationsFromRedis(storyId);
    const chapters = await getChaptersFromRedis(storyId);
    let newPdfUrl = null;
    if (chapters.length > 0) {
      const childName = savedChildName || childData.name;
      const pdfBase64 = await generatePDF(childName, chapters, childData, tier, finalIllustrations, outline);
      const blob = await put(`pdfs/${storyId}/full-book.pdf`, Buffer.from(pdfBase64, 'base64'), {
        access: 'public',
        contentType: 'application/pdf'
      });
      newPdfUrl = blob.url;
      await redisRequest("SET", [`fullbookurl:${storyId}`, newPdfUrl, "EX", 2592000]);
    } else {
      console.error(`No chapters found for ${storyId} — can't rebuild the PDF, only the Redis illustration URLs were fixed`);
    }

    const stillMissing = expectedKeys.filter((k) => !finalIllustrations[k]);

    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
        to: process.env.ADMIN_ALERT_EMAIL || "hello@growingminds.io",
        subject: `🔧 Illustration recovery — ${storyId}`,
        text: `Recovered ${recovered}/${missingKeys.length} missing images for ${storyId}.\n\n` +
          (newPdfUrl ? `Corrected PDF: ${newPdfUrl}\n(The original review email's PDF link is now stale — use this one to actually look at the book before approving. The "Approve & Send" button on the original email will still work correctly and submit this corrected PDF to Lulu.)\n\n` : `Could not rebuild the PDF — no chapters found in Redis.\n\n`) +
          (stillMissing.length ? `Still missing after this run: ${stillMissing.join(', ')}\n` : 'All expected images now present.\n') +
          (failures.length ? `\nFailures this run:\n${failures.map(f => `${f.key}: ${f.error}`).join('\n')}` : '')
      });
    } catch (e) { console.error("Recovery confirmation email failed:", e.message); }

    return res.status(200).json({
      ok: true,
      storyId,
      recovered,
      attempted: missingKeys.length,
      stillMissing,
      failures,
      newPdfUrl,
    });
  } catch (err) {
    console.error("[recover-missing-illustrations] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
