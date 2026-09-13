// api/inngest.js — tiered stories + Nano Banana Pro (Gemini) illustrations
const { serve } = require("inngest/node");
const { Inngest } = require("inngest");
const https = require("https");
const { Resend } = require("resend");
const { put, del } = require("@vercel/blob");

const inngest = new Inngest({
  id: "growingminds",
  eventKey: process.env.INNGEST_EVENT_KEY
});

// ── STORY TIERS BY AGE ──
function getStoryTier(age) {
  const a = parseInt(age);
  if (a <= 5) return { chapCount: 30, minWords: 200, maxWords: 400, maxTokensPerChap: 800,  imageCount: 15, imagesPerChap: 0, label: "illustrated novel" };
  if (a <= 9) return { chapCount: 30, minWords: 300, maxWords: 600, maxTokensPerChap: 1200, imageCount: 10, imagesPerChap: 0, label: "illustrated chapter book" };
  return       { chapCount: 30, minWords: 400, maxWords: 800, maxTokensPerChap: 1600, imageCount: 5,  imagesPerChap: 0, label: "novel" };
}

// ── MAIN INNGEST FUNCTION ──
const generateStoryOrder = inngest.createFunction(
  {
    id: "generate-story-order",
    retries: 2,
    timeout: "60m",
    // Catch-all safety net: fires once a run exhausts its retries and fails for good,
    // no matter which step or line caused it — so a failure mode nobody specifically
    // wrote an alert for still gets one, instead of only showing up in Vercel logs.
    onFailure: async ({ event, error }) => {
      const orig = event.data.event?.data || {};
      await sendAlertEmail(
        `Full order FAILED — ${orig.childName || 'unknown'} (${orig.storyId || 'unknown'})`,
        `generate-story-order failed permanently after exhausting retries.\n\nstoryId: ${orig.storyId}\nchildName: ${orig.childName}\ncustomerEmail: ${orig.customerEmail}\n\nError: ${error?.name}: ${error?.message}`
      );
    }
  },
  { event: "order/completed" },
  async ({ event, step }) => {
    const { storyToken, childName, storyId, customerEmail, customDetails } = event.data;
    const childData = decodeStoryData(storyToken);
    if (!childData) throw new Error("Could not decode story token");
    // Merge customDetails from event (not stored in token to keep it short)
    if (customDetails) childData.customDetails = customDetails;

    const tier = getStoryTier(childData.age);
    console.log(`Starting ${tier.label} for ${childName} (${tier.chapCount} chapters)`);

    // Step 1: Generate chapter outline — save to Redis immediately
    const outline = await step.run("generate-outline", async () => {
      // Use cached outline from generate-preview if available (same story as $2.99 preview)
      const cached = await redisRequest("GET", [`outline:${storyId}`]);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            console.log(`Using cached outline for ${storyId} (${parsed.length} chapters)`);
            return parsed;
          }
        } catch(e) {}
      }
      const result = await generateOutline(childData, tier);
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(result), "EX", 2592000]);
      console.log(`Saved outline with ${result.length} chapters to Redis`);
      return result;
    });

    // The preview already wrote and emailed chapters 1-3 (or however many) to the
    // customer — reuse that exact text instead of asking Claude to write it again
    // from scratch, which produces different prose even from the same outline.
    // Memoized in its own step so a retry mid-run can't shift these boundaries.
    const startChapter = await step.run("check-existing-chapters", async () => {
      const existing = await getChaptersFromRedis(storyId);
      if (existing.length > 0) {
        console.log(`Reusing ${existing.length} chapters already written for ${storyId}`);
      }
      return existing.length;
    });

    // Step 2: Generate remaining chapters in batches — save each batch to Airtable
    // immediately. This means chapter text never lives in Inngest state.
    const BATCH_SIZE = 4;
    const batches = Math.ceil(Math.max(0, outline.length - startChapter) / BATCH_SIZE);

    for (let b = 0; b < batches; b++) {
      await step.run(`generate-batch-${b + 1}`, async () => {
        const start = startChapter + b * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, outline.length);
        console.log(`Generating batch ${b + 1}/${batches}: chapters ${start + 1}–${end}`);

        // Retrieve prior chapters from Redis for context
        const priorChapters = await getChaptersFromRedis(storyId);

        // Generate this batch
        const batchChapters = await generateChapterBatch(childData, outline, start, end, priorChapters, tier);

        // Save to Redis immediately
        await saveChaptersToRedis(storyId, priorChapters, batchChapters);

        return { saved: batchChapters.length };
      });
    }

    // Step 3: Generate illustrations in batches of 10
    let illustrations = {};
    console.log(`ILLUSTRATIONS CHECK: GEMINI_API_KEY=${!!process.env.GEMINI_API_KEY}, SKIP_ILLUSTRATIONS=${process.env.SKIP_ILLUSTRATIONS}`);
    if (process.env.GEMINI_API_KEY && process.env.SKIP_ILLUSTRATIONS !== "true") {
      const IMG_BATCH = 10;
      // Retrieve outline fresh from Redis — Inngest state may be empty on replay
      const freshOutlineData = await redisRequest("GET", [`outline:${storyId}`]);
      const freshOutline = freshOutlineData ? JSON.parse(freshOutlineData) : outline;
      console.log(`Fresh outline length: ${freshOutline.length}`);
      const step2 = Math.floor(freshOutline.length / tier.imageCount);
      const allImageKeys = Array.from({ length: tier.imageCount }, (_, i) =>
        `${Math.min(i * step2, freshOutline.length - 1)}-0`
      );
      // Always ensure chapter 0 (cover) gets an image
      if (!allImageKeys.includes('0-0')) allImageKeys[0] = '0-0';
      console.log(`IMAGE KEYS: outline.length=${freshOutline.length}, tier.imageCount=${tier.imageCount}, keys=${allImageKeys.length}, step2=${step2}`);
      const imgBatches = Math.ceil(allImageKeys.length / IMG_BATCH);
      console.log(`STARTING ${imgBatches} illustration batches`);

      for (let b = 0; b < imgBatches; b++) {
        await step.run(`generate-illustrations-${b + 1}`, async () => {
          const start = b * IMG_BATCH;
          const keys = allImageKeys.slice(start, start + IMG_BATCH);
          console.log(`Generating illustration batch ${b + 1}/${imgBatches}: ${keys.length} images`);

          const { name, age, hair, hairLength, hairStyle, eye, city, region, genre, customDetails } = childData;
          const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
          const charDesc = `a young child with ${hairDesc} hair and ${eye} eyes`;

          // Only the primary character (and any secondary character with an explicit
          // physical description) gets drawn as a specific, identifiable individual —
          // other named people in the story (friends, siblings, classmates) may be real
          // people, so they must never get an invented likeness.
          const illustrationDetails = extractIllustrationDetails(customDetails);
          const characterPolicy = `\n\nIMPORTANT — depicting people: Only ${name} should be drawn as a specific, identifiable individual with a consistent face and appearance. Any other named real person in the scene — parents, siblings, friends, etc. — must be left OUT of the illustration entirely unless a physical description for them is explicitly given below. Do not include them even as a generic, faceless, or turned-away figure — omit them completely and focus the illustration on ${name} and the setting/action instead, since any invented depiction risks looking nothing like the real person.${illustrationDetails ? `\n\nPhysical descriptions to match exactly for these people if they appear in the scene:\n${illustrationDetails}` : ''}`;

          // Genre-specific illustration style
          const genreVisual = {
            'Magic & Wizards': 'cozy cottage magic, glowing spell effects, warm candlelight',
            'Enchanted Forest': 'lush woodland, soft dappled light, fairy tale flora',
            'Friendly Dragons': 'bright colorful dragon, friendly fantasy world',
            'Animal Kingdom': 'beatrix potter style, cozy anthropomorphic animals',
            'Cozy Magic': 'studio ghibli inspired, warm town setting, everyday magic',
            'Unicorns & Magic': 'rainbow meadows, sparkle and shimmer, magical creatures',
            'Wizard Academy': 'magical boarding school, gothic architecture, warm torch light',
            'Dragon Rider': 'epic mountain vistas, dragon in flight, sweeping skies',
            'Enchanted Quest': 'classic fantasy landscape, portal worlds, magical kingdoms',
            'Superhero Origin': 'dynamic comic book style, action poses, bright colors',
            'Mystery & Magic': 'atmospheric fog, mysterious glowing clues, enchanted detective',
            'Space & Stars': 'nebula backgrounds, alien worlds, bioluminescent colors',
            'Underwater Kingdom': 'bioluminescent ocean, coral castles, flowing water light',
            'Epic Fantasy': 'sweeping epic landscape, dramatic lighting, ancient world',
            'Dark Magic': 'moody atmospheric, forbidden library, mysterious shadows',
            'Sci-Fi Adventure': 'futuristic world, neon lights, sleek technology',
            'Superhero Chronicles': 'cinematic comic style, dramatic skies, hero silhouette',
            'Dragon & Sword': 'high fantasy, ancient ruins, epic dragon scale detail',
            'Time & Portals': 'swirling portals, multiple time periods, glowing edges',
          }[genre] || 'whimsical fantasy illustration, warm colors';

          const baseStyle = getIllustrationBaseStyle(age);
          const styleGuide = parseInt(age) <= 5
            ? `${baseStyle} Softer and gentler energy for a younger reader. ${genreVisual}`
            : parseInt(age) <= 9
            ? `${baseStyle} Bright, dynamic, colorful energy. ${genreVisual}`
            : `${baseStyle} Detailed, dramatic, cinematic energy. ${genreVisual}`;

          const result = {};
          const failures = [];

          // Reuse the preview's literal cover image if the customer already saw one —
          // same exact image, not just a freshly-generated same-looking-character cover.
          const existingUrls = await getIllustrationsFromRedis(storyId);

          // One private reference image anchors consistency for the cover and every
          // interior scene alike — reused across batches and across preview→upgrade
          // via its own long-lived Redis key, never regenerated as a side effect of
          // generating the cover.
          const referencePrompt = `${styleGuide}. The main character is ${charDesc}. Setting: ${city}, ${region}.${characterPolicy}`;
          const referenceBytes = await getOrCreateCharacterReference(storyId, referencePrompt);

          for (const key of keys) {
            const [ci] = key.split('-').map(Number);
            const chap = freshOutline[ci] || { imagePrompt: `${name} on an adventure in ${city}` };
            const scenePrompt = `${styleGuide}. Scene: ${chap.imagePrompt} The main character is ${charDesc}. Setting: ${city}, ${region}. No text or letters in the image.${characterPolicy}`;
            const isCover = key === '0-0';

            if (isCover && existingUrls['0-0']) {
              result['0-0'] = existingUrls['0-0'];
              console.log(`Image 0-0 reused from preview cover: ${existingUrls['0-0'].slice(0, 60)}`);
              continue;
            }

            try {
              const gen = await callGeminiImage([
                { inlineData: { mimeType: "image/png", data: referenceBytes.toString("base64") } },
                { text: `This is the SAME character shown in the reference image — keep hair, eyes, face, and outfit identical. New scene: ${scenePrompt}` }
              ], isCover ? { aspectRatio: "3:4", imageSize: "4K" } : { aspectRatio: "4:3", imageSize: "2K" });

              const blob = await put(`illustrations/${storyId}/${key}.png`, gen.bytes, {
                access: 'public',
                contentType: 'image/png'
              });
              result[key] = blob.url;
              console.log(`Image ${key} generated with character consistency (Nano Banana Pro, ${isCover ? '4K cover' : '2K'})`);
            } catch(err) {
              console.error(`Image ${key} failed: ${err.message}`);
              failures.push({ key, error: err.message });
            }
          }
          await saveIllustrationsToRedis(storyId, result);
          if (failures.length > 0) {
            await sendAlertEmail(
              `Illustration failures — ${childName}'s book (${storyId})`,
              `Batch ${b + 1}/${imgBatches}: ${failures.length}/${keys.length} images failed.\n\n` +
              failures.map(f => `${f.key}: ${f.error}`).join('\n')
            );
          }
          return { saved: Object.keys(result).length, failed: failures.length };
        });
      }
    } else {
      console.log("Skipping illustrations");
      if (!process.env.GEMINI_API_KEY) {
        await sendAlertEmail(
          `Illustrations skipped — GEMINI_API_KEY missing`,
          `Order for ${childName} (storyId ${storyId}) is shipping with no illustrations because GEMINI_API_KEY is not set in the environment.`
        );
      }
    }

    // The 10-chapter delivery email is intentionally gone — full orders are meant to
    // ship as a physical book via Lulu (not yet wired into this flow) rather than a
    // partial PDF by email. Chapters/illustrations generated above are still saved to
    // Airtable and Blob below for whenever that pipeline exists.

    // Step: Build the full book PDF and notify admin with a link — not attached, so
    // there's no email attachment size ceiling to worry about, just a Blob URL.
    const fullPdfUrl = await step.run("create-full-pdf", async () => {
      console.log(`Building full ${tier.chapCount}-chapter PDF for ${storyId}`);
      try {
        const chapters = await getChaptersFromRedis(storyId);
        const illustrationUrls = await getIllustrationsFromRedis(storyId);
        const pdfBase64 = await generatePDF(childName, chapters, childData, tier, illustrationUrls, outline);
        const blob = await put(`pdfs/${storyId}/full-book.pdf`, Buffer.from(pdfBase64, 'base64'), {
          access: 'public',
          contentType: 'application/pdf'
        });
        console.log(`Full book PDF uploaded to Blob: ${blob.url}`);
        return blob.url;
      } catch (e) {
        await sendAlertEmail(
          `Full book PDF generation failed — ${childName} (${storyId})`,
          `generatePDF/upload threw: ${e.message}`
        );
        throw e;
      }
    });

    await step.run("notify-full-book-ready", async () => {
      await sendOrderNotification(
        `Full book ready — ${childName} (${storyId})`,
        `The full book (all ${tier.chapCount} chapters) is ready to view:\n${fullPdfUrl}\n\nStory ID: ${storyId}\nChild: ${childName}\nCustomer: ${customerEmail || 'n/a'}`
      );
    });

    // Step 6: Save full story to Airtable for training data
    await step.run("save-story", async () => {
      console.log(`Saving story to Airtable for ${childName}`);
      const allChapters = await getChaptersFromRedis(storyId);
      await saveStoryToAirtable(storyId, customerEmail, childName, childData, allChapters);
    });

    // Step 7: Clean up Redis and Blob storage
    await step.run("cleanup", async () => {
      await deleteChaptersFromRedis(storyId);
      // Delete illustration URLs from Redis and files from Blob
      try {
        const imgKeys = await redisRequest("KEYS", [`img:${storyId}:*`]);
        if (imgKeys && imgKeys.length > 0) {
          const urls = [];
          for (const k of imgKeys) {
            const url = await redisRequest("GET", [k]);
            if (url) urls.push(url);
            await redisRequest("DEL", [k]);
          }
          // Delete from Vercel Blob
          if (urls.length > 0) await del(urls);
        }
      } catch(e) { console.error("Illustration cleanup error:", e.message); }
      try {
        const refUrl = await redisRequest("GET", [`charref:${storyId}`]);
        if (refUrl) await del(refUrl);
        await redisRequest("DEL", [`charref:${storyId}`]);
      } catch(e) { console.error("Character reference cleanup error:", e.message); }
      await redisRequest("DEL", [`outline:${storyId}`]);
      console.log(`Cleaned up Redis and Blob for ${storyId}`);
    });

    console.log(`✅ Complete for ${childName}`);
    return { success: true, childName, tier: tier.label };
  }
);

// ── PREVIEW CHAPTERS ($2.99 flow) ──
const generatePreviewChapters = inngest.createFunction(
  {
    id: "generate-preview-chapters",
    retries: 2,
    timeout: "45m",
    // Same catch-all as generate-story-order — fires once a run permanently fails,
    // regardless of which step caused it.
    onFailure: async ({ event, error }) => {
      const orig = event.data.event?.data || {};
      await sendAlertEmail(
        `Preview FAILED — ${orig.childName || 'unknown'} (${orig.storyId || 'unknown'})`,
        `generate-preview-chapters failed permanently after exhausting retries.\n\nstoryId: ${orig.storyId}\nchildName: ${orig.childName}\ncustomerEmail: ${orig.customerEmail}\n\nError: ${error?.name}: ${error?.message}`
      );
    }
  },
  { event: "story/preview.purchased" },
  async ({ event, step }) => {
    const { storyToken, childName, storyId, customerEmail, customDetails } = event.data;

    const childData = decodeStoryData(storyToken);
    if (!childData) throw new Error("Could not decode story token");
    if (customDetails) childData.customDetails = customDetails;

    const age = parseInt(childData.age);
    const tier = getStoryTier(childData.age);

    // Generate outline
    const outline = await step.run("generate-preview-outline", async () => {
      const result = await generateOutline(childData, tier);
      // 30-day TTL — must still be here whenever the customer upgrades to the full book.
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(result), "EX", 2592000]);
      return result;
    });

    // Generate first 3 chapters only
    const chapters = await step.run("generate-preview-batch", async () => {
      const priorChapters = [];
      const newChapters = await generateChapterBatch(childData, outline, 0, 3, priorChapters, tier);
      await saveChaptersToRedis(storyId, [], newChapters);
      return newChapters;
    });

    // Generate cover illustration
    await step.run("generate-preview-cover", async () => {
      const { name, age, hair, hairLength, hairStyle, eye, city, region, genre, customDetails } = childData;
      const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
      const charDesc = `a young child with ${hairDesc} hair and ${eye} eyes`;
      // Only the primary character (and any secondary character with an explicit
      // physical description) gets drawn as a specific, identifiable individual —
      // see the same policy in the full-order illustration step for why.
      const illustrationDetails = extractIllustrationDetails(customDetails);
      const characterPolicy = `\n\nIMPORTANT — depicting people: Only ${name} should be drawn as a specific, identifiable individual with a consistent face and appearance. Any other named real person in the scene — parents, siblings, friends, etc. — must be left OUT of the illustration entirely unless a physical description for them is explicitly given below. Do not include them even as a generic, faceless, or turned-away figure — omit them completely and focus the illustration on ${name} and the setting/action instead, since any invented depiction risks looking nothing like the real person.${illustrationDetails ? `\n\nPhysical descriptions to match exactly for these people if they appear in the scene:\n${illustrationDetails}` : ''}`;
      const genreVisual = {
        'Magic & Wizards': 'cozy cottage magic, glowing spell effects, warm candlelight',
        'Enchanted Forest': 'lush woodland, soft dappled light, fairy tale flora',
        'Friendly Dragons': 'bright colorful dragon, friendly fantasy world',
        'Animal Kingdom': 'cozy anthropomorphic animals, warm illustrated style',
        'Cozy Magic': 'studio ghibli inspired, warm town setting, everyday magic',
        'Unicorns & Magic': 'rainbow meadows, sparkle and shimmer, magical creatures',
        'Wizard Academy': 'magical boarding school, gothic architecture, warm torch light',
        'Dragon Rider': 'epic mountain vistas, dragon in flight, sweeping skies',
        'Enchanted Quest': 'classic fantasy landscape, portal worlds, magical kingdoms',
        'Superhero Origin': 'dynamic comic book style, action poses, bright colors',
        'Mystery & Magic': 'atmospheric fog, mysterious glowing clues',
        'Space & Stars': 'nebula backgrounds, alien worlds, bioluminescent colors',
        'Underwater Kingdom': 'bioluminescent ocean, coral castles, flowing water light',
        'Epic Fantasy': 'sweeping epic landscape, dramatic lighting, ancient world',
        'Dark Magic': 'moody atmospheric, forbidden library, mysterious shadows',
        'Sci-Fi Adventure': 'futuristic world, neon lights, sleek technology',
        'Superhero Chronicles': 'cinematic comic style, dramatic skies, hero silhouette',
        'Dragon & Sword': 'high fantasy, ancient ruins, epic dragon scale detail',
        'Time & Portals': 'swirling portals, multiple time periods, glowing edges',
      }[genre] || 'whimsical fantasy illustration, warm colors';
      const baseStyle = getIllustrationBaseStyle(age);
      const styleGuide = parseInt(age) <= 5
        ? `${baseStyle} Softer and gentler energy for a younger reader. ${genreVisual}`
        : parseInt(age) <= 9
        ? `${baseStyle} Bright, dynamic, colorful energy. ${genreVisual}`
        : `${baseStyle} Detailed, dramatic, cinematic energy. ${genreVisual}`;
      const chap = outline[0] || { imagePrompt: `${name} leaning forward mid-step, caught in a moment of discovery in ${city}` };
      const scenePrompt = `${styleGuide}. Scene: ${chap.imagePrompt} The main character is ${charDesc}. Setting: ${city}, ${region}. No text or letters in the image.${characterPolicy}`;
      try {
        // Same private-reference pattern as the full order — see getOrCreateCharacterReference.
        // This reference (and, once generated, the cover itself) both survive on their own
        // long-lived Redis keys, so the full order reuses this exact cover on upgrade.
        const referencePrompt = `${styleGuide}. The main character is ${charDesc}. Setting: ${city}, ${region}.${characterPolicy}`;
        const referenceBytes = await getOrCreateCharacterReference(storyId, referencePrompt);
        const gen = await callGeminiImage([
          { inlineData: { mimeType: "image/png", data: referenceBytes.toString("base64") } },
          { text: `This is the SAME character shown in the reference image — keep hair, eyes, face, and outfit identical. New scene: ${scenePrompt}` }
        ], { aspectRatio: "3:4", imageSize: "4K" });
        const blob = await put(`illustrations/${storyId}/0-0.png`, gen.bytes, {
          access: 'public',
          contentType: 'image/png'
        });
        await saveIllustrationsToRedis(storyId, { '0-0': blob.url });
        console.log(`Preview cover uploaded (Nano Banana Pro, 4K): ${blob.url.slice(0, 60)}`);
      } catch(e) {
        console.error(`Preview cover failed: ${e.message}`);
        await sendAlertEmail(
          `Preview cover failed — ${childName} (${storyId})`,
          `Gemini image generation failed for the $2.99 preview cover: ${e.message}`
        );
      }
    });

    // Generate PDF of 3 chapters
    const pdfUrl = await step.run("create-preview-pdf", async () => {
      const illustrationUrls = await getIllustrationsFromRedis(storyId);
      // Blob URLs straight through — see the create-pdf-v3 comment above.
      const pdfBase64 = await generatePDF(childName, chapters, childData, tier, illustrationUrls, outline);
      // Inngest caps a step's return value at 4MB — upload to Blob and return only the URL.
      const blob = await put(`pdfs/${storyId}/preview.pdf`, Buffer.from(pdfBase64, 'base64'), {
        access: 'public',
        contentType: 'application/pdf'
      });
      console.log(`Preview PDF uploaded to Blob: ${blob.url}`);
      return blob.url;
    });

    // Send email with PDF
    await step.run("send-preview-email", async () => {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const storyTitle = `${childName} and the ${getMilestoneTitle(childData.milestone)}`;
      try {
        const pdfBase64 = (await fetchImageBytes(pdfUrl)).toString('base64');
      // The Resend SDK does NOT throw on API-level errors — it resolves normally
      // with { data: null, error }. Without this check, a rejected send (bad
      // recipient, domain issue, rate limit) logs as "sent" and is never caught.
      const { data: sendData, error: sendError } = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
        to: customerEmail,
        bcc: "purchase@growingminds.io",
        subject: `📖 Here are ${childName}'s first 3 chapters!`,
        attachments: [{ filename: `${childName}-preview.pdf`, content: pdfBase64 }],
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e;">
            <div style="background:#2d6a4f;padding:2rem;text-align:center;border-radius:12px 12px 0 0;">
              <h1 style="color:white;font-size:1.5rem;margin:0;">🌱 Growing Minds</h1>
            </div>
            <div style="background:#fefae0;padding:2rem;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;">
              <h2 style="color:#2d6a4f;">${storyTitle}</h2>
              <p>The first 3 chapters of ${childName}'s story are attached — enjoy a taste of the adventure!</p>
              <p style="margin-top:1rem;color:#6b7280;font-size:.9rem;">Ready for the full 30-chapter story? Order the complete hardcover book and it will be printed and shipped to your door.</p>

              <div style="text-align:center;margin:1.5rem 0;">
                <a href="https://www.growingminds.io/upgrade.html?sid=${storyId}&name=${encodeURIComponent(childName)}" style="display:inline-block;background:#f9c74f;color:#5c3d2e;font-family:sans-serif;font-size:1rem;font-weight:900;text-decoration:none;padding:.9rem 2rem;border-radius:12px;box-shadow:0 4px 14px rgba(249,199,79,0.4);">✨ Get the Full 30-Chapter Book — $35 →</a>
                <p style="font-size:.75rem;color:#9ca3af;margin-top:.5rem;">Your $2.99 is credited toward the full price</p>
              </div>

              <div style="background:white;border:2px solid #86efac;border-radius:12px;padding:1.2rem;margin-top:1rem;text-align:center;">
                <div style="font-size:.75rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#16a34a;margin-bottom:.4rem;">Your Family Story ID</div>
                <div style="font-family:monospace;font-size:1rem;font-weight:700;color:#14532d;background:#f0fdf4;border-radius:6px;padding:.4rem .8rem;display:inline-block;margin:.3rem 0;">${storyId}</div>
                <p style="font-size:.8rem;color:#4b7c5a;margin:.5rem 0 0 0;">Save this ID when ordering the full book!</p>
              </div>
              <p style="color:#6b7280;font-size:.85rem;margin-top:1.5rem;">Questions? Email us at <a href="mailto:hello@growingminds.io" style="color:#2d6a4f;">hello@growingminds.io</a></p>
            </div>
          </div>
        `
      });
      if (sendError) throw new Error(sendError.message || JSON.stringify(sendError));
      console.log(`Preview email sent to ${customerEmail} (id: ${sendData?.id})`);
      } catch (e) {
        // Alert, then rethrow so Inngest's built-in retries still apply — an alerting
        // problem must never mask a delivery problem or suppress the retry.
        await sendAlertEmail(
          `Preview email failed — ${childName} (${storyId})`,
          `Preview email send threw: ${e.message}`
        );
        throw e;
      }
    });

    // Cleanup
    await step.run("cleanup-preview", async () => {
      // Do NOT delete story:${storyId} (chapters) or outline:${storyId} here — same
      // reasoning as the token/images below. The full order reuses this exact
      // outline and these exact chapters 1-3 on upgrade, instead of asking Claude to
      // write different prose from scratch for chapters the customer already read.
      // Both now carry their own 30-day TTL.
      // Do NOT delete img:${storyId}:* here — same reasoning. The full order's
      // illustration step looks up the preview's cover (and the character
      // reference) to reuse them; deleting them here meant every upgrade got a
      // mismatched cover generated from scratch instead of the one the customer
      // already saw. Illustration URLs now carry a 30-day TTL of their own.
      try {
        await del(pdfUrl);
      } catch(e) { console.error("Preview PDF blob cleanup error:", e.message); }
      // Do NOT delete token:${storyId} here — webhook.js needs it to process the
      // upgrade purchase later, which reuses this same storyId. It already has its
      // own 24h TTL from generate-preview.js; deleting it here meant every upgrade
      // purchase failed with "No storyToken found" the moment a customer actually
      // clicked through their preview email to buy the full book.
      console.log(`Cleaned up preview PDF blob for ${storyId}`);
    });

    return { success: true, childName, chapters: 3 };
  }
);

// ── SERVE ──
const handler = serve({ client: inngest, functions: [generateStoryOrder, generatePreviewChapters] });
module.exports = handler;

// ════════════════════════════════════════════
// STORY GENERATION
// ════════════════════════════════════════════

async function generateOutline(child, tier) {
  const { name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone, customDetails, genre, genreStyle } = child;
  const genderPronoun = gender === "girl" ? "she/her" : gender === "boy" ? "he/him" : "they/them";
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const friendLine = friend && friend !== "none" ? `Companion (pet, friend, or sibling): ${friend}.` : "";
  const genreLine = genre ? `\nSTORY GENRE & STYLE: ${genre} — ${genreStyle}` : '';
  const customLine = customDetails ? `\n\nCRITICAL CUSTOM DETAILS — these must be followed precisely:\n${customDetails}\nIMPORTANT NICKNAME RULE: If a nickname is provided for any character, use ONLY that nickname — never invent a different one, never shorten it, never substitute it with another name. Characters may be referred to by their full name OR a provided nickname, but never a made-up alternative.` : "";
  // Only fires for milestones actually about big feelings/emotional regulation —
  // an emotion-gated ability mechanic (a sword that only glows when "happy," say)
  // silently teaches that positive emotions = power and everything else = weakness,
  // which is backwards for exactly this milestone.
  const bigFeelingsMilestone = /big feelings|frustration|anxiety|anger|meltdown|overwhelm/i.test(milestone);
  const emotionFramingLine = bigFeelingsMilestone ? `

EMOTIONAL FRAMING RULE: This milestone is about big feelings, so if the story gives ${name} any ability, power, or tool that responds to their emotional state, it must respond to whether ${name} is present, grounded, and connected — never simply to whether ${name} is "happy." Never frame it as "happy feelings make it stronger, other feelings make it weaker." ${name} should be allowed to feel angry, sad, or frustrated while the story treats those feelings as normal, not as a malfunction or a loss of ability. What restores or strengthens the ability is ${name} returning to a grounded, present state — through breathing, quiet time, or connection with someone else — never simply "cheering up" or "being happy again."` : '';

  const prompt = `You are a children's book author. Create a ${tier.chapCount}-chapter outline for a personalized ${tier.label}.

Hero: ${name}, age ${age}, ${genderPronoun}, ${hairDesc} hair, ${eye} eyes
NAMING RULE: Refer to the hero only as "${name}" and to any other named character only by the name given for them above. Do not invent, shorten, or substitute a nickname for anyone unless the custom details below explicitly provide one for that character — if they do, use exactly that nickname, consistently. A nickname belongs permanently to the one person it was given for — if the custom details say someone (e.g. a parent) calls ${name} by a nickname, that nickname refers ONLY to ${name} for the rest of the story. Never let it drift onto or start referring to the person who uses it, or to anyone else — that person keeps being called by their own name throughout.
PHYSICAL DESCRIPTION RULE: Only ${name} has a physical description you should use (given above). For every other named character — friends, siblings, classmates, anyone — do NOT invent or state any physical trait (hair color or style, eye color, height, build, clothing, etc.) unless the custom details below explicitly give that specific person a description. If someone has no description provided, refer to them only by name, personality, and actions — never guess what they look like.
SETTING RULE: Base ${name}'s real-world settings (home, school, daycare, an after-school program, sports/activities, a relative's house, etc.) on the "WHERE THEY SPEND TIME" section in the custom details below, if present — use only the settings listed there. Never invent a setting like summer camp, a specific program, or an activity that isn't listed there or clearly implied by the milestone itself. If no such section is given, keep settings to home and generic, unnamed everyday places rather than guessing.
PERSONALIZATION FOCUS RULE: You're given a lot of personalized details (favorites, family/friend facts, strengths, quirks, etc.) — don't try to work all of them into the plot with equal weight. Choose 3-5 of the most emotionally consequential ones (the ones most connected to the milestone and ${name}'s specific challenge) and build real plot weight around those. Everything else can appear as brief, light texture or be left out entirely — never force a detail in just because it was provided. Test: if removing a detail would make the story less emotionally meaningful, keep it central; if not, treat it as decoration. This does not apply to the FORBIDDEN/REQUIRED OUTCOME constraints, the nickname rule, the physical description rule, or the setting rule above, which must still be followed exactly.
Personality: ${trait}. Loves: ${favorite}. ${friendLine}
Hometown: ${city}, ${region} — use broad geography (landscape, weather, regional feel), never specific street names or addresses.
Milestone/theme: ${milestone}${genreLine}${customLine}

This is a full ${tier.chapCount}-chapter novel. Structure the arc like a proper novel in the ${genre || 'fantasy'} genre:
- Chapters 1–2: Introduce ${name} and their everyday world, THEN ignite the central ${genre || 'fantasy'} adventure — something genuinely magical, extraordinary, or genre-defining must actually happen on the page during these chapters, not just be hinted at or promised for later. The adventure must already be underway by the time Chapter 3 begins.
- Chapters 3–15: Rising action, complications, deeper adventures, setbacks
- Chapters 16–24: Climax builds, highest stakes, darkest moment
- Chapters 25–30: Resolution, triumph over the milestone, heartwarming ending

SINGLE CLIMAX RULE: The story must build to ONE escalating climax, not two separate crises. If the outline includes what feels like an earlier victory or resolution partway through Chapters 16–24, it must be explicitly a false or partial victory — something is still wrong, incomplete, or about to get harder — that directly causes or connects to the real, larger climax that follows. Never introduce a second, unrelated crisis (a new disaster, villain, or threat with its own separate cause) once an earlier one has already been resolved. Whatever ${name} and their allies built, learned, or gained in the first part of the climax must be exactly what's needed to solve the second, larger part — not a fresh problem requiring a different, unrelated solution.

MILESTONE CAUSALITY RULE: The milestone (${milestone}) must be the actual CAUSE of the story's main complications, not a feeling ${name} occasionally has alongside an otherwise-unrelated adventure. At least one major setback between Chapters 3–24 must happen BECAUSE of ${name}'s particular struggle with this milestone — not because of bad luck, a villain, or an external obstacle that would have gone wrong regardless of who ${name} was. And the eventual success in the climax must be a direct result of ${name} handling that specific struggle differently, not simply overcoming an unrelated obstacle while happening to feel better along the way.

ADULT ROLE RULE: Adults (parents, teachers, coaches, etc.) may comfort ${name}, keep them safe, offer tools, perspective, or a listening presence — but they must never perform the decisive action that resolves the climax or the milestone on ${name}'s behalf. Never have an adult explain the insight ${name} needed to reach themselves, physically solve the culminating problem, or rescue ${name} from the central challenge. ${name} must be the one who takes the decisive action — adults can be present and supportive around that moment, without being the ones who do it.

IDENTITY RULE: The final chapter must leave ${name} with a new belief about who they are, not a restated technique or lesson. Never end on ${name} (or anyone else) summarizing what to do next time or naming the coping trick/skill as the takeaway — instead, show ${name} facing a small, ordinary echo of the milestone and responding differently, or land on a single line of quiet realization about their own identity (e.g. "${name} was someone who came back," "${name} was a good friend now," "${name} didn't give up"). The technique (breathing, asking for help, practicing, whatever it was) can appear earlier in the story, but the last impression of the book must be about who ${name} has become, not what they learned to do.

IMPORTANT: Customers only read Chapters 1–3 in the preview before deciding whether to buy the full book, so both the ${genre || 'fantasy'} hook and the milestone challenge must be clearly underway by the end of Chapter 3 — never save the inciting magical/adventure moment for Chapter 4 or later.

SCENE CONTINUITY RULE: Never open a chapter with a hard reset to a new setting just because time has passed (e.g. "the next day at school," "that weekend at camp") with nothing connecting it to what just happened. Every chapter must carry forward something concrete from the chapter before it — an unresolved problem, a goal ${name} is now pursuing, a question they need answered, or an emotion they're still working through — and that carried-forward thing is what puts ${name} in this chapter's setting, not mere timekeeping. If the location changes, the summary must make clear it changes because of what just happened, not simply because a new day or activity started.

ADVENTURE INTEGRATION RULE: The ${genre || 'fantasy'} adventure must not stay confined to a separate "adventure world" that ${name} visits and then cleanly leaves behind, resetting ordinary life back to mundane in between. Once ignited in Chapters 1–2, it follows ${name} home and stays active in their everyday settings (home, school, family, friends) for the rest of the book — a magic object lives in ${name}'s room, a power shows up at the dinner table, a consequence follows ${name} to school the next day, and so on, whatever fits this story. Ordinary life and the adventure should read as one continuous, escalating thing happening to ${name}, never as two separate categories of scene that alternate. By Chapters 25–30, the adventure's effects should be fully present in ${name}'s ordinary life rather than something wrapped up and left behind in a special separate place.
${emotionFramingLine}

You MUST return EXACTLY ${tier.chapCount} chapters — no more, no fewer.

Return ONLY a valid JSON array of EXACTLY ${tier.chapCount} objects. Each object must have:
- "title": chapter title WITHOUT chapter number (4-6 words, evocative e.g. "The Day Everything Changed")
- "carriesForward": one sentence naming the specific problem, goal, question, or emotion carried over from the previous chapter that drives this chapter's events (for Chapter 1, describe the everyday-world hook that pulls the reader in instead)
- "summary": 2-3 sentence summary of what happens, written so it clearly follows from "carriesForward" rather than starting a fresh, disconnected scene
- "imagePrompt": a 1-sentence description of the key visual moment in this chapter, written as ${name} actively mid-action or mid-discovery (leaning forward, reaching, running, pointing, reacting) with a clear direction of gaze — never ${name} simply standing, posing, or smiling at the viewer

No markdown, no explanation, just the JSON array.`;

  // 6000 was too tight for 30 chapters with the fuller imagePrompt descriptions —
  // caused mid-string JSON truncation, silently falling back to generic chapters.
  const raw = await callClaude(prompt, 12000);
  try {
    // Strip markdown, find the JSON array
    let cleaned = raw.replace(/```json|```/g, "").trim();
    // Find first [ and last ] to extract just the array
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
      cleaned = cleaned.slice(start, end + 1);
    }
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Not an array");
    if (parsed.length !== tier.chapCount) {
      console.warn(`Outline returned ${parsed.length} chapters, expected ${tier.chapCount} — trimming/padding`);
      while (parsed.length < tier.chapCount) {
        parsed.push({ title: `Chapter ${parsed.length + 1}`, carriesForward: `Continues directly from the previous chapter`, summary: `The adventure continues`, imagePrompt: `${name} exploring ${city}` });
      }
      return parsed.slice(0, tier.chapCount);
    }
    return parsed;
  } catch(e) {
    console.error("Outline parse failed, using fallback:", e.message);
    return Array.from({ length: tier.chapCount }, (_, i) => ({
      title: `Chapter ${i + 1}`,
      carriesForward: `Continues directly from the previous chapter`,
      summary: `Part ${i + 1} of ${name}'s adventure`,
      imagePrompt: `${name} on an adventure in ${city}`
    }));
  }
}

// ════════════════════════════════════════════
// BATCH CHAPTER GENERATION
// ════════════════════════════════════════════

async function generateChapterBatch(child, outline, startIdx, endIdx, priorChapters, tier) {
  const { name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone, customDetails } = child;
  const genderPronoun = gender === "girl" ? "she/her" : gender === "boy" ? "he/him" : "they/them";
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const friendLine = friend && friend !== "none" ? `Companion: ${friend}.` : "";

  // Full outline for arc awareness
  const arcContext = outline.map((c, i) =>
    `  Chapter ${i + 1}: "${c.title}" — ${c.summary}`
  ).join('\n');

  // Prior context — just use outline summaries, not full chapter text, to keep prompt size consistent
  const priorText = priorChapters.length > 0
    ? `\n\nWhat has happened so far (chapter summaries):\n` +
      outline.slice(0, startIdx).map((c, i) =>
        `  Chapter ${i + 1}: ${c.title} — ${c.summary}`
      ).join('\n')
    : "";

  // Chapters to write in this batch — carriesForward tells the model exactly what
  // problem/goal/question/emotion this chapter must open by continuing, so scene
  // changes read as caused by what just happened rather than a fresh reset.
  const batchOutline = outline.slice(startIdx, endIdx).map((c, i) =>
    `Chapter ${startIdx + i + 1}: "${c.title}"\n  Carries forward: ${c.carriesForward || '(continues directly from the previous chapter)'}\n  What happens: ${c.summary}`
  ).join('\n');

  const isLastBatch = endIdx >= outline.length;

  const customLine = customDetails ? `\n\nCRITICAL CUSTOM DETAILS — these MUST be followed exactly in every chapter:\n${customDetails}\nPay special attention to any nicknames — use them EVERY time that character is addressed or referenced. Never use a different name for a character who has been given a nickname.` : "";

  const prompt = `You are writing chapters ${startIdx + 1}–${endIdx} of a personalized children's ${tier.label}.

HERO: ${name}, age ${age}, ${genderPronoun}, ${hairDesc} hair, ${eye} eyes
NAMING RULE: Refer to the hero only as "${name}" and to any other named character only by the name given for them. Do not invent, shorten, or substitute a nickname for anyone unless the custom details below explicitly provide one for that character — if they do, use exactly that nickname, consistently. A nickname belongs permanently to the one person it was given for — if the custom details say someone (e.g. a parent) calls ${name} by a nickname, that nickname refers ONLY to ${name} for the rest of the story. Never let it drift onto or start referring to the person who uses it, or to anyone else — that person keeps being called by their own name throughout.
PHYSICAL DESCRIPTION RULE: Only ${name} has a physical description you should use (given above). For every other named character — friends, siblings, classmates, anyone — do NOT invent or state any physical trait (hair color or style, eye color, height, build, clothing, etc.) unless the custom details below explicitly give that specific person a description. If someone has no description provided, refer to them only by name, personality, and actions — never guess what they look like.
Personality: ${trait}. Loves: ${favorite}. ${friendLine}
Setting: ${city}, ${region} — use the city name and regional geography (mountains, rivers, weather, landscape) naturally, but NEVER use specific street names, addresses, or neighbourhood names.
${customLine}
${arcContext}
${priorText}

NOW WRITE these ${endIdx - startIdx} chapters in order:
${batchOutline}

RULES:
- Write all ${endIdx - startIdx} chapters back to back
- NAMES: Never invent a nickname for ${name} or any other character. Use only the names given above, or a nickname only if the custom details explicitly supplied one — and that nickname always means ${name}, never whoever is speaking it or anyone else, in every chapter.
- APPEARANCE: Never invent a physical trait (hair, eyes, height, build, clothing) for a named character who wasn't given one in the custom details — not even a small, throwaway detail. Only describe what was explicitly provided.
- Each chapter: ${tier.minWords}–${tier.maxWords} words, ending on a natural story beat
- CRITICAL WRITING RULE: Never explain what a character is feeling. Show it through physical detail, action, and dialogue only. Wrong: "Benjamin felt angry." Right: "Benjamin's ears went hot. His fists clenched. He walked away without saying anything." Trust the reader to understand.
- Each chapter starts with "Chapter N: Title" on its own line, then a blank line, then the story
- Maintain the exact same characters, setting, and tone throughout
- Each chapter flows naturally from the last — no new unrelated premises
- SCENE LOGIC: Every scene must make physical sense. Characters must be in locations that make sense for the time of day and story context. If a character wakes up, they wake up in their bed. If they are at school, they arrived there. Never have a character inexplicably appear somewhere without getting there first.
- SCENE CONTINUITY: Open each chapter by picking up the "Carries forward" thread listed for it above — the same unresolved problem, goal, question, or emotion the previous chapter left off on. Don't open with an unexplained new setting or a "the next day at ___" reset with nothing connecting it to what just happened; if the location changed, a sentence or two should make clear why it changed now, driven by what just happened, not just because time passed.
- Writing style: ${parseInt(age) <= 5 ? "Warm, lyrical, read-aloud. Short paragraphs. Sensory detail." : parseInt(age) <= 9 ? "Engaging, age-appropriate. Mix of action, humor, emotion." : "Rich vocabulary, complex emotions. Feels like a real middle-grade novel."}
${isLastBatch ? `- The final chapter must resolve the milestone beautifully with warmth and hope, and must land on an identity statement about who ${name} has become — never end on ${name} or anyone else summarizing a technique or lesson ("remember to take a breath," "now I know to ask for help"). Show it through action (a small, ordinary echo of the milestone handled differently) or a single quiet line of realization about who ${name} is now, not what they learned to do.` : ""}
- SAFETY: This is a children's book. Never include swear words, sexual content, or graphic violence. Unnamed side characters may have negative attitudes, rivalry, or conflict — this makes for a better story. However, ${name}${child.friend && child.friend !== 'none' ? ` and ${child.friend.split(' ')[0]}` : ''} must always be portrayed positively and with dignity. All stories must resolve with hope and warmth.

Write all ${endIdx - startIdx} chapters now. Nothing else.`;

  const raw = await callClaude(prompt, tier.maxTokensPerChap * (endIdx - startIdx) + 500);

  // Split the response into individual chapters
  const chapTexts = raw.split(/(?=Chapter \d+:)/g).filter(c => c.trim());
  
  // Make sure we got the right number — pad or trim if needed
  while (chapTexts.length < endIdx - startIdx) {
    chapTexts.push(`Chapter ${startIdx + chapTexts.length + 1}: The Adventure Continues\n\nThe story continued on...`);
  }
  
  return chapTexts.slice(0, endIdx - startIdx);
}

// Nano Banana Pro (gemini-3-pro-image). `parts` follows Gemini's generateContent
// content-part format: [{ text }] and/or [{ inlineData: { mimeType, data (base64) } }]
// for feeding a reference image back in. `imageConfig` is { aspectRatio, imageSize }
// — imageSize "1K"/"2K"/"4K", default "1K" if omitted. No free tier; billing must be
// enabled on the Google Cloud project behind GEMINI_API_KEY.
function callGeminiImage(parts, imageConfig) {
  const payload = JSON.stringify({
    contents: [{ parts }],
    generationConfig: imageConfig ? { imageConfig } : undefined,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      path: "/v1beta/models/gemini-3-pro-image:generateContent",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      timeout: 120000,
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(data.error.message));

          const responseParts = data.candidates?.[0]?.content?.parts || [];
          const imagePart = responseParts.find((p) => p.inlineData?.data);
          if (!imagePart) {
            return reject(new Error("No image in Gemini response: " + JSON.stringify(data).slice(0, 300)));
          }

          resolve({
            bytes: Buffer.from(imagePart.inlineData.data, "base64"),
            mimeType: imagePart.inlineData.mimeType || "image/png",
          });
        } catch (e) {
          reject(new Error("Gemini parse error: " + body.slice(0, 300)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Gemini timeout")));
    req.write(payload);
    req.end();
  });
}

// One private reference image per story, anchoring character consistency across
// every customer-facing illustration (cover + interior scenes) and across the
// preview→upgrade boundary. Never shown to the customer — no scene, no other
// characters, no text or labels — so the cover no longer has to double as a
// reference sheet and risk Gemini fusing both into one composite image.
async function getOrCreateCharacterReference(storyId, prompt) {
  const existingUrl = await redisRequest("GET", [`charref:${storyId}`]);
  if (existingUrl) {
    try {
      return await fetchImageBytes(existingUrl);
    } catch (e) {
      console.error(`Failed to fetch existing character reference, regenerating: ${e.message}`);
    }
  }
  const gen = await callGeminiImage(
    [{ text: `${prompt}\n\nCharacter reference sheet — full body, front-facing, neutral pose, clear view of face and outfit, plain neutral background. No scene, no other characters, no text or labels in the image.` }],
    { aspectRatio: "3:4", imageSize: "2K" }
  );
  const blob = await put(`illustrations/${storyId}/reference.png`, gen.bytes, {
    access: 'public',
    contentType: 'image/png'
  });
  await redisRequest("SET", [`charref:${storyId}`, blob.url, "EX", 2592000]);
  console.log(`Character reference created for ${storyId}: ${blob.url}`);
  return gen.bytes;
}

function fetchImageBytes(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      timeout: 60000
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Image fetch timeout")));
    req.end();
  });
}

// customDetails is one big blob (story constraints, milestone answers, family/friend
// notes, "things to get right", etc.) meant for story-text generation. Image prompts
// only care about the "Illustration details — <section>: name, age, gender, look"
// lines the intake form's per-person appearance-note cards produce — pulling just
// those out means the model isn't hunting for one physical detail in a lot of
// unrelated text.
function extractIllustrationDetails(customDetails) {
  if (!customDetails) return '';
  return customDetails
    .split('\n')
    .filter(line => line.trim().startsWith('Illustration details'))
    .join('\n');
}

// Shared face/pose direction for every character-generating image call (private
// reference sheet, cover, interior illustrations) so the hero reads the same way
// everywhere — a real, age-accurate kid who always looks warm and heroic, never
// mean or smug, even mid-prank or mid-surprise.
function getIllustrationBaseStyle(age) {
  return `Heroic storybook character illustration, Pixar-style 3D glossy render, high production quality. Character is charismatic, confident, and adventurous — the hero of the frame, not a passive subject presented to the viewer. The child must look like an actual ${age}-year-old, with age-accurate proportions and facial maturity — not a toddler or preschooler, even in a soft/rounded illustration style. Face: large expressive eyes with a warm, delighted gaze and directional focus — avoid perfectly round, startled, or vacant eyes, and avoid narrowed or squinted eyes, which read as scheming or combative rather than joyful. Default to a visible, open, genuine smile with relaxed (not furrowed) eyebrows unless the specific scene explicitly calls for a different emotion like fear, sadness, or worry — confidence and determination should come through posture and action, not a narrowed-eye or smirking expression, which reads as mean or aggressive rather than heroic. If other characters share the scene, their expressions should feel emotionally consistent with the moment (everyone reads as delighted in a joyful scene) rather than one character looking hostile or aggressive while another looks frightened or overjoyed. COMPOSITION WITH PROPS: If the hero is holding, swinging, or using an object near another character (a toy, tool, weapon-shaped prop, etc.), never frame it as aimed, swung, or pointed AT that person — even in a clearly friendly scene, that framing reads as an attack rather than play. Instead show the object being raised triumphantly, held up to share, or used alongside the other character in a joint moment — the other character should read as a joyful participant or witness, never a target. Pose: dynamic and open — shoulders back, chest forward, caught mid-action or mid-discovery, strong recognizable silhouette. Composition: character-forward cinematic framing, child occupying a strong portion of the frame from a dynamic angle — never a centered, static portrait. Lighting: warm cinematic illumination with luminous rim light and dimensional contrast that makes the character feel important. Avoid: passive standing portraits, timid smiles, head tilted down, hands hanging awkwardly, generic cute-kid aesthetic, stiff centered compositions, smug or mean facial expressions, toddler-like proportions.`;
}

function getMilestoneTitle(milestone) {
  const map = {
    "Starting kindergarten": "Brave New Day",
    "Learning to read": "Magic of Words",
    "Losing a first tooth": "Wobbly Tooth",
    "Riding a bike without training wheels": "Great Bike Ride",
    "Starting middle school": "New Adventure",
    "Dealing with anxiety or school pressure": "Brave Heart",
    "Trying something scary or new": "Leap of Courage",
    "Navigating friendships and social dynamics": "Friend Quest",
    "Joining a sports team or club": "Big Team",
    "Dealing with big feelings or frustration": "Feeling Storm",
    "Standing up for themselves or a friend": "Brave Stand",
    "Taking on a new responsibility at home": "Big Helper",
    "Learning to use the potty": "Big Step",
    "Starting preschool or daycare": "First Day",
    "Making a new friend": "Hello, Friend",
    "Sharing with others": "Giving Heart",
  };
  return map[milestone] || "Big Adventure";
}

// ════════════════════════════════════════════
// EMAIL
// ════════════════════════════════════════════

// ════════════════════════════════════════════
// PDF GENERATION VIA PDFSHIFT
// ════════════════════════════════════════════

async function generatePDF(childName, chapters, child, tier, illustrations = {}, outline = null) {
  const { milestone, city, region, age } = child;
  const storyTitle = `${childName} and the ${getMilestoneTitle(milestone)}`;
  const writtenCount = chapters.length;
  const totalCount = (outline && outline.length > writtenCount) ? outline.length : writtenCount;
  const isPreview = totalCount > writtenCount;
  const wordCount = `${(writtenCount * tier.minWords).toLocaleString()}–${(writtenCount * tier.maxWords).toLocaleString()}`;

  const chaptersHtml = chapters.map((chapText, ci) => {
    const lines = chapText.split(/\n+/).filter(l => l.trim());
    const fullTitle = lines[0] || `Chapter ${ci + 1}`;
    // Split "Chapter N: Title" into number and title
    const match = fullTitle.match(/^(Chapter \d+):\s*(.+)$/);
    const chapterNum = match ? match[1] : `Chapter ${ci + 1}`;
    const chapterTitle = match ? match[2] : fullTitle;

    const body = lines.slice(1).map(p => `<p>${p}</p>`).join('');

    // Check if this chapter has an illustration — use URL directly
    // Skip chapter 0: its image (key "0-0") is already shown full-bleed as the cover
    const key = `${ci}-0`;
    const illustrationHtml = (ci > 0 && illustrations[key])
      ? `<img src="${illustrations[key]}" />`
      : '';

    return `
      <div class="chapter">
        <div class="chapter-number">${chapterNum}</div>
        <div class="chapter-title">${chapterTitle}</div>
        <div class="chapter-divider"></div>
        <div class="chapter-body">
          ${illustrationHtml}
          ${body}
        </div>
        <div class="chapter-end">✦</div>
      </div>
    `;
  }).join('');

  // Build TOC rows — two columns. In preview mode (writtenCount < totalCount),
  // every chapter title comes from the outline so the full arc shows as a table
  // of contents; rows beyond what's actually written in this PDF render greyed
  // out as a "coming in the full book" tease. In full-book mode every chapter is
  // written, so every row renders the same normal style.
  const tocItems = isPreview && outline
    ? outline.slice(0, totalCount).map((c, i) => ({ num: i + 1, title: c.title, included: i < writtenCount }))
    : chapters.map((chapText, ci) => {
        const firstLine = chapText.split(/\n+/)[0] || '';
        const match = firstLine.match(/^Chapter (\d+):\s*(.+)$/);
        return { num: match ? match[1] : String(ci + 1), title: match ? match[2] : firstLine, included: true };
      });

  const tocRow = (item) => {
    const numColor = item.included ? '#2d6a4f' : '#9ca3af';
    const titleColor = item.included ? '#1a1a2e' : '#9ca3af';
    const titleStyle = item.included ? 'font-weight:600;' : 'font-weight:600;font-style:italic;';
    const suffix = item.included ? '' : ' ✦';
    return '<tr>' +
      `<td style="padding:5px 8px 5px 0;width:24px;font-size:8pt;color:${numColor};font-weight:800;">${item.num}</td>` +
      `<td style="padding:5px 0;font-size:9pt;color:${titleColor};${titleStyle}">${item.title}${suffix}</td>` +
      '</tr>';
  };

  const tocRowsLeft = tocItems.slice(0, 15).map(tocRow).join('');
  const tocRowsRight = tocItems.slice(15, 30).map(tocRow).join('');

  const tocFootnote = isPreview
    ? `✦ You're previewing Chapters 1–${writtenCount}. The complete ${totalCount}-chapter story continues when you order the full book.`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* Lulu print spec for pod_package_id 0550X0850... (5.5x8.5in trim, perfect bound):
     page = trim + 0.125in bleed on all sides (needed for the full-bleed cover page below).
     Content padding = bleed(0.125in) + 0.5in safety margin + gutter allowance for a
     151-400pp book (this 30-chapter book lands there), applied uniformly on both left/right
     since a single-flow HTML render can't alternate recto/verso gutter sides. */
  @page { size: 5.75in 8.75in; margin: 0; }
  /* Cream page tint is preview-only — the full book reuses this same template as
     the eventual Lulu print interior, and a full-bleed background on every page
     would add ink coverage cost there once that pipeline is wired in. */
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 13pt; line-height: 1.9; color: #1a1a2e;${isPreview ? ' background: #fdfbf5; -webkit-print-color-adjust: exact; print-color-adjust: exact;' : ''} }

  /* ── COVER ── */
  .cover {
    width: 100%; height: 100vh;
    background: #1a3a2a;
    position: relative; overflow: hidden;
    page-break-after: always;
    display: flex; flex-direction: column;
  }

  /* Full bleed illustration covers the entire cover page */
  .cover-image {
    position: absolute; top: 0; left: 0;
    width: 100%; height: 100%;
    object-fit: cover;
  }

  /* Dark scrim behind the title block so text stays readable over the artwork */
  .cover-gradient {
    position: absolute; bottom: 0; left: 0;
    width: 100%; height: 58%;
    background: linear-gradient(to bottom, transparent, rgba(8,18,13,0.5) 45%, rgba(8,18,13,0.92) 100%);
  }

  /* Text panel — sits over the image + scrim, no background of its own */
  .cover-panel {
    position: absolute; bottom: 0; left: 0;
    width: 100%;
    padding: 60px 108px 48px;
    display: flex; flex-direction: column; justify-content: flex-end;
    gap: 0;
  }

  .cover-badge {
    display: inline-block;
    background: #f9c74f;
    color: #1a1a2e;
    font-family: Arial, sans-serif;
    font-size: 7.5pt;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
    padding: 4px 12px;
    border-radius: 20px;
    margin-bottom: 12px;
    width: fit-content;
  }

  .cover-title-line1 {
    font-family: Georgia, serif;
    font-size: 12pt;
    font-weight: 700;
    color: rgba(255,255,255,0.85);
    letter-spacing: .04em;
    margin-bottom: 2px;
    text-shadow: 0 2px 10px rgba(0,0,0,0.6);
  }

  .cover-title-main {
    font-family: Georgia, serif;
    font-size: 28pt;
    font-weight: 900;
    color: #ffffff;
    line-height: 1.1;
    margin-bottom: 12px;
    text-shadow: 0 2px 14px rgba(0,0,0,0.65);
  }

  .cover-divider {
    width: 40px; height: 2px;
    background: rgba(255,255,255,0.25);
    margin-bottom: 10px;
  }

  .cover-meta {
    font-family: Arial, sans-serif;
    font-size: 8pt;
    color: rgba(255,255,255,0.45);
    line-height: 1.5;
    margin-bottom: 10px;
  }

  .cover-publisher {
    font-family: Arial, sans-serif;
    font-size: 7.5pt;
    color: rgba(255,255,255,0.25);
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  .chapter { padding: 60px 108px; page-break-before: always; position: relative; }
  .chapter-number {
    font-family: Arial, sans-serif;
    font-size: 8pt;
    font-weight: 800;
    letter-spacing: .18em;
    text-transform: uppercase;
    color: #2d6a4f;
    margin-bottom: 6px;
  }
  .chapter-title {
    font-family: ${parseInt(age) <= 9 ? "Georgia, serif" : "Georgia, serif"};
    font-size: ${parseInt(age) <= 5 ? '22pt' : '18pt'};
    color: #1a1a2e;
    margin-bottom: 28px;
    line-height: 1.2;
  }
  .chapter-divider {
    width: 40px; height: 3px;
    background: #2d6a4f;
    margin-bottom: 28px;
    border-radius: 2px;
  }

  /* Body text */
  .chapter-body p {
    font-family: Arial, sans-serif;
    font-size: ${parseInt(age) <= 5 ? '14pt' : parseInt(age) <= 9 ? '13pt' : '12pt'};
    line-height: ${parseInt(age) <= 5 ? '2.2' : '2.0'};
    font-weight: ${parseInt(age) <= 9 ? '600' : '500'};
    color: #1a1a2e;
    margin-bottom: ${parseInt(age) <= 5 ? '1.4em' : '1.2em'};
    text-align: left;
  }

  /* Drop cap on first paragraph of each chapter */
  .chapter-body p:first-child::first-letter {
    font-family: Georgia, serif;
    font-size: 4em;
    font-weight: 900;
    color: #2d6a4f;
    float: left;
    line-height: 0.75;
    margin-right: 6px;
    margin-top: 8px;
  }

  /* Illustrations */
  .chapter-body img {
    width: 100%;
    max-width: 420px;
    display: block;
    margin: 2rem auto;
    border-radius: 8px;
    box-shadow: 0 3px 16px rgba(0,0,0,0.13);
  }

  /* Chapter end ornament */
  .chapter-end {
    text-align: center;
    color: #2d6a4f;
    font-size: 16pt;
    margin-top: 2rem;
    opacity: 0.4;
  }

  /* Page footer - removed, causes overlap with PDFShift */

  /* Title page (after cover) */
  .title-page {
    height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    text-align: center;
    padding: 60px 108px;
    page-break-after: always;
  }
  .title-page-name {
    font-family: Arial, sans-serif;
    font-size: 10pt;
    font-weight: 800;
    letter-spacing: .15em;
    text-transform: uppercase;
    color: #2d6a4f;
    margin-bottom: 1.5rem;
  }
  .title-page-title {
    font-family: Georgia, serif;
    font-size: 28pt;
    font-weight: 900;
    color: #1a1a2e;
    line-height: 1.2;
    margin-bottom: 1rem;
  }
  .title-page-divider {
    width: 60px; height: 2px; background: #e5e7eb; margin: 0 auto 2.5rem;
  }
  .title-page-dedication {
    font-family: Arial, sans-serif;
    font-size: 11pt;
    font-style: italic;
    color: #6b7280;
    line-height: 1.8;
  }
  .title-page-publisher {
    margin-top: 2rem;
    font-family: Arial, sans-serif;
    font-size: 8pt;
    color: #b0b8c1;
    letter-spacing: .06em;
  }
</style>
</head>
<body>

  <!-- COVER -->
  <div class="cover">
    ${illustrations['0-0'] ? `<img class="cover-image" src="${illustrations['0-0']}" />` : `<div style="position:absolute;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#2d6a4f,#1a3a2a);"></div>`}
    <div class="cover-gradient"></div>
    <div class="cover-panel">
      <div class="cover-badge">${isPreview ? 'Story Preview' : 'A Growing Minds Original Story'}</div>
      <div class="cover-title-line1">${childName} and the</div>
      <div class="cover-title-main">${getMilestoneTitle(milestone)}</div>
      <div class="cover-divider"></div>
      <div class="cover-meta">Written for ${childName}, age ${age} &nbsp;·&nbsp; ${city}, ${region} &nbsp;·&nbsp; ${isPreview ? `Chapters 1–${writtenCount} of ${totalCount}` : `${wordCount} words`}</div>
      <div class="cover-publisher">🌱 growingminds.io</div>
    </div>
  </div>

  <!-- TITLE PAGE -->
  <div class="title-page">
    <div>
      <div class="title-page-name">${isPreview ? 'A story preview written for' : 'A story written for'}</div>
      <div class="title-page-title">${childName} and the ${getMilestoneTitle(milestone)}</div>
      <div class="title-page-divider"></div>
      <div class="title-page-dedication">
        This story was written just for ${childName},<br/>
        age ${age}, of ${city}, ${region}.<br/>
        Every adventure in these pages belongs to you.
      </div>
    </div>
    <div style="font-family:Arial,sans-serif;font-size:8pt;color:#b0b8c1;letter-spacing:.06em;margin-top:auto;padding-top:40px;">🌱 Growing Minds · growingminds.io · © ${new Date().getFullYear()}</div>
  </div>

  <!-- TABLE OF CONTENTS -->
  <div style="padding:60px 108px;page-break-before:always;page-break-after:always;">
    <div style="font-family:Arial,sans-serif;font-size:7pt;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#2d6a4f;margin-bottom:8px;">Contents</div>
    <div style="font-family:Georgia,serif;font-size:20pt;font-weight:900;color:#1a1a2e;margin-bottom:16px;">Table of Contents</div>
    <div style="width:36px;height:2px;background:#2d6a4f;margin-bottom:24px;border-radius:2px;"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 40px;">
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
        ${tocRowsLeft}
      </table>
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
        ${tocRowsRight}
      </table>
    </div>
    ${tocFootnote ? `<div style="margin-top:20px;padding:12px 16px;background:#f9fafb;border-radius:8px;font-family:Arial,sans-serif;font-size:8pt;color:#6b7280;">${tocFootnote}</div>` : ''}
  </div>
  ${chaptersHtml}

</body>
</html>`;

  console.log(`HTML size before PDFShift: ${Math.round(html.length / 1024)}KB`);
  const payload = JSON.stringify({
    source: html,
    landscape: false,
    use_print: false,
    margin: "0",
    // Must match Lulu's required page size for pod_package_id 0550X0850... : 5.5x8.5in
    // trim + 0.125in bleed on all sides = 5.75x8.75in. (Was "Letter" — wrong trim size.)
    format: "5.75inx8.75in",
    sandbox: false
  });

  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`api:${process.env.PDFSHIFT_API_KEY}`).toString('base64');
    const options = {
      hostname: "api.pdfshift.io",
      port: 443,
      path: "/v3/convert/pdf",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Authorization": `Basic ${auth}`
      },
      timeout: 120000
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          const pdfBuffer = Buffer.concat(chunks);
          console.log(`PDF generated: ${Math.round(pdfBuffer.length / 1024)}KB`);
          resolve(pdfBuffer.toString("base64"));
        } else {
          const body = Buffer.concat(chunks).toString();
          reject(new Error(`PDFShift error ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("PDFShift timeout")));
    req.write(payload);
    req.end();
  });
}

// ════════════════════════════════════════════
// EMAIL
// ════════════════════════════════════════════

// Ops alert — separate from customer-facing email. Failures here must never block
// order fulfillment (a customer's book should still ship even if the alert can't
// send), so this always resolves rather than throwing.
async function sendAlertEmail(subject, details) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    // The Resend SDK does NOT throw on API-level errors (bad recipient, domain
    // issue, rate limit, etc.) — it resolves normally with { data: null, error }.
    // Without this check, a rejected send looks identical to a successful one.
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
      to: process.env.ADMIN_ALERT_EMAIL || "hello@growingminds.io",
      subject: `⚠️ ${subject}`,
      text: details
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
    console.log(`Alert email sent: ${subject} (id: ${data?.id})`);
  } catch (e) {
    console.error(`Alert email failed to send: ${e.message}`);
  }
}

// Purely informational — same channel as webhook.js's purchase notification, just
// fired later, once the full book actually exists to link to.
async function sendOrderNotification(subject, details) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
      to: process.env.ORDER_NOTIFICATION_EMAIL || "purchase@growingminds.io",
      subject: `📖 ${subject}`,
      text: details
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
    console.log(`Order notification sent: ${subject} (id: ${data?.id})`);
  } catch (e) {
    console.error(`Order notification failed to send: ${e.message}`);
  }
}

// ════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════

function callClaude(prompt, maxTokens) {
  const payload = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      timeout: 180000
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(data.error.message));
          resolve(data.content[0].text.trim());
        } catch(e) {
          reject(new Error("Claude parse error: " + body.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Claude timeout")));
    req.write(payload);
    req.end();
  });
}

// ════════════════════════════════════════════
// UPSTASH REDIS CHAPTER STORAGE
// ════════════════════════════════════════════

async function redisRequest(command, args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
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
      timeout: 30000
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.result);
        } catch(e) {
          reject(new Error(`Redis parse error: ${data.slice(0, 100)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Redis timeout")));
    req.write(payload);
    req.end();
  });
}

async function saveChaptersToRedis(storyId, priorChapters, newChapters) {
  const allChapters = [...priorChapters, ...newChapters];
  // 30-day TTL — the preview's chapters must still be here whenever the customer
  // upgrades to the full book, which can happen well outside a 2h window.
  await redisRequest("SET", [`story:${storyId}`, JSON.stringify(allChapters), "EX", 2592000]);
  console.log(`Saved ${allChapters.length} chapters to Redis for ${storyId}`);
}

async function getChaptersFromRedis(storyId) {
  const data = await redisRequest("GET", [`story:${storyId}`]);
  if (!data) return [];
  try { return JSON.parse(data); }
  catch(e) { return []; }
}

async function deleteChaptersFromRedis(storyId) {
  await redisRequest("DEL", [`story:${storyId}`]);
  console.log(`Deleted Redis key story:${storyId}`);
}

async function saveIllustrationsToRedis(storyId, newIllustrations) {
  // 30-day TTL, not 2h — the preview's cover must still be findable whenever the
  // customer upgrades to the full book, which can happen well outside a 2h window.
  for (const [key, url] of Object.entries(newIllustrations)) {
    await redisRequest("SET", [`img:${storyId}:${key}`, url, "EX", 2592000]);
  }
  console.log(`Saved ${Object.keys(newIllustrations).length} illustration URLs to Redis for ${storyId}`);
}

async function getIllustrationsFromRedis(storyId) {
  const result = {};
  try {
    const keysResult = await redisRequest("KEYS", [`img:${storyId}:*`]);
    if (!keysResult || !Array.isArray(keysResult)) return {};
    for (const redisKey of keysResult) {
      const imageKey = redisKey.replace(`img:${storyId}:`, '');
      const url = await redisRequest("GET", [redisKey]);
      if (url) result[imageKey] = url;
    }
    console.log(`Retrieved ${Object.keys(result).length} illustration URLs from Redis`);
  } catch(e) {
    console.error(`Error retrieving illustrations: ${e.message}`);
  }
  return result;
}

function decodeStoryData(token) {
  try {
    // Strip surrounding quotes if Redis returned them
    let t = token;
    if (t && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
    return JSON.parse(Buffer.from(t, "base64url").toString("utf-8"));
  } catch { return null; }
}

async function saveStoryToAirtable(storyId, customerEmail, childName, child, chapters) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const token  = process.env.AIRTABLE_TOKEN;
  if (!baseId || !token) { console.log("No Airtable credentials — skipping story save"); return; }

  const { age, milestone, city, region } = child;
  const fullStory = chapters.join('\n\n---\n\n');
  const wordCount = fullStory.split(/\s+/).length;

  const payload = JSON.stringify({
    records: [{
      fields: {
        "Story ID":   storyId,
        "Child Age":  parseInt(age) || 0,
        "Milestone":  milestone || "",
        "City":       `${city}, ${region}`,
        "Full Story": fullStory.slice(0, 100000), // Airtable long text limit
        "Word Count": wordCount,
        "Created At": new Date().toISOString().split("T")[0]
      }
    }]
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.airtable.com",
      port: 443,
      path: `/v0/${baseId}/Stories`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: 30000
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`Airtable Stories ${res.statusCode}: ${body.slice(0, 80)}`);
        } else {
          // Non-blocking: training-data save failure shouldn't stop order fulfillment/cleanup,
          // but must be a visible error, not a silent log line, so it can actually be noticed.
          console.error(`Airtable Stories FAILED ${res.statusCode}: ${body.slice(0, 200)}`);
        }
        resolve();
      });
    });
    req.on("error", (e) => { console.error(`Airtable Stories request error: ${e.message}`); resolve(); });
    req.write(payload);
    req.end();
  });
}
