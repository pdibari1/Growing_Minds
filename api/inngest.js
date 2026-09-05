// api/inngest.js — Full version with tiered stories + DALL-E 3 illustrations
const { serve } = require("inngest/node");
const { Inngest } = require("inngest");
const https = require("https");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
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
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(result), "EX", 7200]);
      console.log(`Saved outline with ${result.length} chapters to Redis`);
      return result;
    });

    // Step 2: Generate chapters in batches — save each batch to Airtable immediately
    // This means chapter text never lives in Inngest state
    const BATCH_SIZE = 4;
    const batches = Math.ceil(outline.length / BATCH_SIZE);

    for (let b = 0; b < batches; b++) {
      await step.run(`generate-batch-${b + 1}`, async () => {
        const start = b * BATCH_SIZE;
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

          const { name, age, hair, hairLength, hairStyle, eye, city, region, genre, friend, customDetails } = childData;
          const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
          const charDesc = `a young child with ${hairDesc} hair and ${eye} eyes`;

          // Only the primary character (and any secondary character with an explicit
          // physical description) gets drawn as a specific, identifiable individual —
          // other named people in the story (friends, siblings, classmates) may be real
          // people, so they must never get an invented likeness.
          const characterPolicy = `\n\nIMPORTANT — depicting people: Only ${name} should be drawn as a specific, identifiable individual with a consistent face and appearance. Do not invent a specific face or likeness for${friend && friend !== 'none' ? ` ${friend.split(' ')[0]} or` : ''} any other named person in the scene unless a physical description for them is explicitly given below — if they appear, render them as a generic, non-specific figure (turned away, partially out of frame, or without distinguishing individual features) rather than a recognizable character.${customDetails ? `\n\nPhysical descriptions to honor if provided for anyone besides ${name}: ${customDetails}` : ''}`;

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

          const styleGuide = parseInt(age) <= 5
            ? `soft watercolor children's book illustration, warm pastel colors, gentle and whimsical, ${genreVisual}`
            : parseInt(age) <= 9
            ? `vibrant digital children's book illustration, colorful and expressive, ${genreVisual}`
            : `detailed digital illustration, cinematic lighting, ${genreVisual}`;

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

    // Step 4: Generate PDF with first 10 chapters only (stays under PDFShift 2MB limit)
    const pdfUrl = await step.run("create-pdf-v3", async () => {
      console.log(`STARTING PDF GENERATION v3`);
      const chapters = await getChaptersFromRedis(storyId);
      const illustrationUrls = await getIllustrationsFromRedis(storyId);
      console.log(`PDF v3: ${chapters.length} chapters, ${Object.keys(illustrationUrls).length} illustration URLs`);
      // Pass Blob URLs straight through — PDFShift fetches <img src="https://..."> itself,
      // so the HTML payload we send stays small regardless of image resolution. Inlining
      // base64 here previously ballooned the payload with a single 4K illustration and
      // crashed/timed out the function mid-step.
      const pdfBase64 = await generatePDF(childName, chapters.slice(0, 10), childData, tier, illustrationUrls);
      // Inngest caps a step's return value at 4MB — a PDF with illustrations easily
      // exceeds that, so upload it to Blob and return only the URL.
      const blob = await put(`pdfs/${storyId}/delivery.pdf`, Buffer.from(pdfBase64, 'base64'), {
        access: 'public',
        contentType: 'application/pdf'
      });
      console.log(`PDF v3 uploaded to Blob: ${blob.url}`);
      return blob.url;
    });
    // Step 5: Send email with PDF of first 10 chapters
    await step.run("send-email", async () => {
      console.log(`Sending email to ${customerEmail}`);
      try {
        const pdfBase64 = (await fetchImageBytes(pdfUrl)).toString('base64');
        await sendDeliveryEmail(customerEmail, childName, pdfBase64, childData, tier, storyId);
      } catch (e) {
        // Alert, then rethrow so Inngest's built-in retries still apply — an alerting
        // problem must never mask a delivery problem or suppress the retry.
        await sendAlertEmail(
          `Delivery email failed — ${childName} (${storyId})`,
          `sendDeliveryEmail threw: ${e.message}`
        );
        throw e;
      }
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
        await del(pdfUrl);
      } catch(e) { console.error("PDF blob cleanup error:", e.message); }
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
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(result), "EX", 7200]);
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
      const { name, age, hair, hairLength, hairStyle, eye, city, region, genre, friend, customDetails } = childData;
      const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
      const charDesc = `a young child with ${hairDesc} hair and ${eye} eyes`;
      // Only the primary character (and any secondary character with an explicit
      // physical description) gets drawn as a specific, identifiable individual —
      // see the same policy in the full-order illustration step for why.
      const characterPolicy = `\n\nIMPORTANT — depicting people: Only ${name} should be drawn as a specific, identifiable individual with a consistent face and appearance. Do not invent a specific face or likeness for${friend && friend !== 'none' ? ` ${friend.split(' ')[0]} or` : ''} any other named person in the scene unless a physical description for them is explicitly given below — if they appear, render them as a generic, non-specific figure (turned away, partially out of frame, or without distinguishing individual features) rather than a recognizable character.${customDetails ? `\n\nPhysical descriptions to honor if provided for anyone besides ${name}: ${customDetails}` : ''}`;
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
      const baseStyle = "Heroic storybook character illustration, Pixar-style 3D glossy render, high production quality. Character is charismatic, confident, and adventurous — the hero of the frame, not a passive subject presented to the viewer. Face: large expressive eyes with a confident, purposeful gaze and directional focus — avoid perfectly round, startled, or vacant eyes. Expressive eyebrows, lively confident expression (curious, determined, delighted, or mischievous rather than merely cute or shy). Pose: dynamic and open — shoulders back, chest forward, caught mid-action or mid-discovery, strong recognizable silhouette. Composition: character-forward cinematic framing, child occupying a strong portion of the frame from a dynamic angle — never a centered, static portrait. Lighting: warm cinematic illumination with luminous rim light and dimensional contrast that makes the character feel important. Avoid: passive standing portraits, timid smiles, head tilted down, hands hanging awkwardly, generic cute-kid aesthetic, stiff centered compositions.";
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
      const pdfBase64 = await generatePDF(childName, chapters, childData, tier, illustrationUrls);
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
      await resend.emails.send({
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
      console.log(`Preview email sent to ${customerEmail}`);
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
      await deleteChaptersFromRedis(storyId);
      // Do NOT delete img:${storyId}:* here — same reasoning as the token below.
      // The full order's illustration step looks up the preview's cover (and the
      // character reference) to reuse them; deleting them here meant every upgrade
      // got a mismatched cover generated from scratch instead of the one the
      // customer already saw. Illustration URLs now carry a 30-day TTL of their own.
      try {
        await del(pdfUrl);
      } catch(e) { console.error("Preview PDF blob cleanup error:", e.message); }
      await redisRequest("DEL", [`outline:${storyId}`]);
      // Do NOT delete token:${storyId} here — webhook.js needs it to process the
      // upgrade purchase later, which reuses this same storyId. It already has its
      // own 24h TTL from generate-preview.js; deleting it here meant every upgrade
      // purchase failed with "No storyToken found" the moment a customer actually
      // clicked through their preview email to buy the full book.
      console.log(`Cleaned up preview Redis for ${storyId}`);
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

  const prompt = `You are a children's book author. Create a ${tier.chapCount}-chapter outline for a personalized ${tier.label}.

Hero: ${name}, age ${age}, ${genderPronoun}, ${hairDesc} hair, ${eye} eyes
Personality: ${trait}. Loves: ${favorite}. ${friendLine}
Hometown: ${city}, ${region} — use broad geography (landscape, weather, regional feel), never specific street names or addresses.
Milestone/theme: ${milestone}${genreLine}${customLine}

This is a full ${tier.chapCount}-chapter novel. Structure the arc like a proper novel in the ${genre || 'fantasy'} genre:
- Chapters 1–5: Introduce ${name} and their world, establish the milestone challenge
- Chapters 6–15: Rising action, complications, adventures, setbacks
- Chapters 16–24: Climax builds, highest stakes, darkest moment
- Chapters 25–30: Resolution, triumph over the milestone, heartwarming ending

You MUST return EXACTLY ${tier.chapCount} chapters — no more, no fewer.

Return ONLY a valid JSON array of EXACTLY ${tier.chapCount} objects. Each object must have:
- "title": chapter title WITHOUT chapter number (4-6 words, evocative e.g. "The Day Everything Changed")
- "summary": 2-3 sentence summary of what happens
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
        parsed.push({ title: `Chapter ${parsed.length + 1}`, summary: `The adventure continues`, imagePrompt: `${name} exploring ${city}` });
      }
      return parsed.slice(0, tier.chapCount);
    }
    return parsed;
  } catch(e) {
    console.error("Outline parse failed, using fallback:", e.message);
    return Array.from({ length: tier.chapCount }, (_, i) => ({
      title: `Chapter ${i + 1}`,
      summary: `Part ${i + 1} of ${name}'s adventure`,
      imagePrompt: `${name} on an adventure in ${city}`
    }));
  }
}

async function generateChapter(child, outline, index, tier) {
  const { name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone, customDetails, genre, genreStyle } = child;
  const genderPronoun = gender === "girl" ? "she/her" : gender === "boy" ? "he/him" : "they/them";
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const friendLine = friend && friend !== "none" ? `Companion (pet, friend, or sibling): ${friend}.` : "";
  const genreLine = genre ? `\nSTORY GENRE & STYLE: ${genre} — ${genreStyle}` : '';
  const isFirst = index === 0;
  const isLast = index === outline.length - 1;
  const chap = outline[index];

  // Build story arc context — full outline so Claude knows where the story is going
  const arcContext = outline.map((c, i) => `  Chapter ${i + 1}: ${c.title} — ${c.summary}`).join('\n');

  // Recent context — summaries of last 3 chapters so Claude stays on track
  const recentContext = index > 0
    ? `\nWhat has happened so far (last ${Math.min(index, 3)} chapters):\n` +
      outline.slice(Math.max(0, index - 3), index).map((c, i) => 
        `  Chapter ${Math.max(1, index - 2) + i}: ${c.title} — ${c.summary}`
      ).join('\n')
    : "";

  const prompt = `Write Chapter ${index + 1} of a personalized children's ${tier.label}.

Chapter title: "${chap.title}"
What happens in THIS chapter: ${chap.summary}
${recentContext}

Full story arc (for consistency — do NOT jump ahead):
${arcContext}

Hero: ${name}, age ${age}, ${genderPronoun}, ${hairDesc} hair, ${eye} eyes
Personality: ${trait}. Loves: ${favorite}. ${friendLine}
Setting: ${city}, ${region} — use the city name and regional geography naturally, but never specific street names, addresses, or neighbourhood names.
Central theme: ${milestone}
Genre & style: ${genre || 'fantasy adventure'} — ${genreStyle || 'imaginative and engaging'}
${isFirst ? "\nThis is the opening chapter — establish the world vividly, introduce the hero with warmth and charm." : ""}
${isLast ? "\nThis is the final chapter — resolve the milestone beautifully, end with warmth and hope." : ""}

Writing style: ${parseInt(age) <= 5 ? "Warm, lyrical, read-aloud sentences. Short paragraphs. Rich sensory detail." : parseInt(age) <= 9 ? "Engaging, age-appropriate vocabulary. Mix of action, humor, and emotion." : "Rich vocabulary, complex emotions, vivid scenes. Feels like a real middle-grade novel."}

LENGTH: Write until the scene reaches a natural story beat — a moment of tension, discovery, emotion, or resolution. Do not pad to fill a word count. Do not cut short before the scene is complete. Minimum ${tier.minWords} words, maximum ${tier.maxWords} words.

CRITICAL WRITING RULE: Never explain what a character is feeling. Show it through physical detail, action, and dialogue only. Wrong: "Benjamin felt angry." Right: "Benjamin's ears went hot. His fists clenched at his sides. He didn't say anything — he just walked away." The reader will understand. Trust them.

CRITICAL: This chapter must follow directly from what came before and lead naturally into the next. Stay true to the established characters, setting, and tone. Do not introduce unrelated premises.
CHARACTERS: Every person mentioned — siblings, friends, pets, parents — must be portrayed warmly and positively. No eye-rolling, dismissiveness, mockery, or negativity from any character toward another.
CHAPTER ENDING: End on a natural beat — a moment of curiosity, warmth, anticipation, or quiet resolution. Never end mid-scene.

FORMAT:
- First line MUST be exactly: "Chapter ${index + 1}: ${chap.title}"
- Then a blank line
- Then the full story text
- Nothing else`;

  return await callClaude(prompt, tier.maxTokensPerChap + 200);
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

  // Chapters to write in this batch
  const batchOutline = outline.slice(startIdx, endIdx).map((c, i) =>
    `Chapter ${startIdx + i + 1}: "${c.title}" — ${c.summary}`
  ).join('\n');

  const isLastBatch = endIdx >= outline.length;

  const customLine = customDetails ? `\n\nCRITICAL CUSTOM DETAILS — these MUST be followed exactly in every chapter:\n${customDetails}\nPay special attention to any nicknames — use them EVERY time that character is addressed or referenced. Never use a different name for a character who has been given a nickname.` : "";

  const prompt = `You are writing chapters ${startIdx + 1}–${endIdx} of a personalized children's ${tier.label}.

HERO: ${name}, age ${age}, ${genderPronoun}, ${hairDesc} hair, ${eye} eyes
Personality: ${trait}. Loves: ${favorite}. ${friendLine}
Setting: ${city}, ${region} — use the city name and regional geography (mountains, rivers, weather, landscape) naturally, but NEVER use specific street names, addresses, or neighbourhood names.
${customLine}
${arcContext}
${priorText}

NOW WRITE these ${endIdx - startIdx} chapters in order:
${batchOutline}

RULES:
- Write all ${endIdx - startIdx} chapters back to back
- Each chapter: ${tier.minWords}–${tier.maxWords} words, ending on a natural story beat
- CRITICAL WRITING RULE: Never explain what a character is feeling. Show it through physical detail, action, and dialogue only. Wrong: "Benjamin felt angry." Right: "Benjamin's ears went hot. His fists clenched. He walked away without saying anything." Trust the reader to understand.
- Each chapter starts with "Chapter N: Title" on its own line, then a blank line, then the story
- Maintain the exact same characters, setting, and tone throughout
- Each chapter flows naturally from the last — no new unrelated premises
- SCENE LOGIC: Every scene must make physical sense. Characters must be in locations that make sense for the time of day and story context. If a character wakes up, they wake up in their bed. If they are at school, they arrived there. Never have a character inexplicably appear somewhere without getting there first.
- Writing style: ${parseInt(age) <= 5 ? "Warm, lyrical, read-aloud. Short paragraphs. Sensory detail." : parseInt(age) <= 9 ? "Engaging, age-appropriate. Mix of action, humor, emotion." : "Rich vocabulary, complex emotions. Feels like a real middle-grade novel."}
${isLastBatch ? "- The final chapter must resolve the milestone beautifully with warmth and hope." : ""}
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

// ════════════════════════════════════════════
// PDF GENERATION
// ════════════════════════════════════════════

async function createStoryPDF(child, chapters, illustrations, tier) {
  const { name, age, city, region, milestone } = child;
  const pdfDoc = await PDFDocument.create();
  const timesRoman = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const timesBold  = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const helvetica  = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 432, pageHeight = 648, margin = 54;
  const contentW = pageWidth - margin * 2;
  const green = rgb(0.176, 0.416, 0.310);
  const gold  = rgb(0.976, 0.780, 0.310);
  const dark  = rgb(0.1, 0.1, 0.15);
  const grey  = rgb(0.6, 0.6, 0.6);

  // ── COVER PAGE ──
  const cover = pdfDoc.addPage([pageWidth, pageHeight]);

  // Try to use cover illustration if available
  if (illustrations[0]) {
    try {
      const img = await pdfDoc.embedJpg(illustrations[0]).catch(() => pdfDoc.embedPng(illustrations[0]));
      cover.drawImage(img, { x: 0, y: pageHeight * 0.35, width: pageWidth, height: pageHeight * 0.65 });
      // Dark overlay for text readability
      cover.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight * 0.42, color: green });
    } catch(e) {
      cover.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: green });
    }
  } else {
    cover.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: green });
  }

  cover.drawText(`${name} and the`, { x: margin, y: pageHeight * 0.35, font: timesBold, size: 26, color: rgb(1,1,1) });
  cover.drawText(getMilestoneTitle(milestone), { x: margin, y: pageHeight * 0.35 - 36, font: timesBold, size: 26, color: gold });
  cover.drawText("A Growing Minds Original Story", { x: margin, y: pageHeight * 0.35 - 72, font: helvetica, size: 10, color: rgb(0.8,0.9,0.85) });
  cover.drawText(`Written for ${name}, age ${age}`, { x: margin, y: pageHeight * 0.18, font: helBold, size: 12, color: rgb(1,1,1) });
  cover.drawText(`${city}, ${region}`, { x: margin, y: pageHeight * 0.18 - 18, font: timesRoman, size: 10, color: rgb(0.8,0.9,0.85) });
  cover.drawText("growingminds.io", { x: margin, y: margin, font: helvetica, size: 9, color: rgb(0.6,0.8,0.7) });

  // ── STORY PAGES ──
  let page = null, cursorY = 0, pageNum = 1;
  const fontSize = 13, topY = pageHeight - margin, bottomY = margin + 30;

  // Use char-count based wrapping — much faster than widthOfTextAtSize per word
  const charsPerBodyLine  = 62; // ~13pt Times Roman in 324px content width
  const charsPerTitleLine = 52; // ~15pt Times Bold

  function wrapText(text, charsPerLine) {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (test.length > charsPerLine && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  function newPage() {
    page = pdfDoc.addPage([pageWidth, pageHeight]);
    cursorY = topY;
  }

  function addPageNum() {
    page.drawText(`${pageNum++}`, { x: pageWidth / 2 - 5, y: margin - 15, font: timesRoman, size: 10, color: grey });
  }

  function drawWrappedText(text, font, size, color, charsPerLine) {
    const lh = size * 1.5;
    const lines = wrapText(text, charsPerLine || charsPerBodyLine);
    for (const l of lines) {
      if (cursorY < bottomY) { addPageNum(); newPage(); }
      page.drawText(l, { x: margin, y: cursorY, font, size, color });
      cursorY -= lh;
    }
  }

  newPage();

  for (let ci = 0; ci < chapters.length; ci++) {
    const chapText = chapters[ci];
    const chapLines = chapText.split(/\n+/).filter(l => l.trim());

    // Chapter title (first line)
    if (chapLines.length > 0) {
      cursorY -= 24;
      if (cursorY < bottomY + 80) { addPageNum(); newPage(); }
      page.drawRectangle({ x: margin, y: cursorY + 6, width: contentW, height: 2, color: green });
      cursorY -= 14;
      drawWrappedText(chapLines[0], timesBold, 15, green, charsPerTitleLine);
      cursorY -= 8;
    }

    // Chapter body paragraphs with images interspersed
    const bodyLines = chapLines.slice(1);
    const imagesPerChap = tier.imagesPerChap || 0;
    const insertAfterPara = imagesPerChap > 0
      ? bodyLines.map((_, i) => i).filter(i => {
          const interval = Math.floor(bodyLines.length / imagesPerChap);
          return interval > 0 && (i + 1) % interval === 0;
        }).slice(0, imagesPerChap)
      : [];

    let imgIdx = 0;
    for (let li = 0; li < bodyLines.length; li++) {
      cursorY -= 4;
      drawWrappedText(bodyLines[li], timesRoman, fontSize, dark, charsPerBodyLine);

      // Insert image after this paragraph if scheduled
      if (insertAfterPara.includes(li) && imgIdx < imagesPerChap) {
        const key = `${ci}-${imgIdx}`;
        if (illustrations[key]) {
          try {
            const img = await pdfDoc.embedJpg(illustrations[key]).catch(() => pdfDoc.embedPng(illustrations[key]));
            const imgH = Math.min(180, cursorY - bottomY - 20);
            if (imgH > 60) {
              const imgW = Math.min(contentW, imgH * (img.width / img.height));
              const imgX = margin + (contentW - imgW) / 2;
              cursorY -= 12;
              if (cursorY - imgH < bottomY) { addPageNum(); newPage(); }
              page.drawImage(img, { x: imgX, y: cursorY - imgH, width: imgW, height: imgH });
              cursorY -= imgH + 16;
            }
          } catch(e) {
            console.error(`Failed to embed image ${key}:`, e.message);
          }
        }
        imgIdx++;
      }
    }

    cursorY -= 24; // Space between chapters
  }

  // Final page num
  if (page) addPageNum();

  return await pdfDoc.save();
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

async function generatePDF(childName, chapters, child, tier, illustrations = {}) {
  const { milestone, city, region, age } = child;
  const storyTitle = `${childName} and the ${getMilestoneTitle(milestone)}`;
  const wordCount = `${(tier.chapCount * tier.minWords).toLocaleString()}–${(tier.chapCount * tier.maxWords).toLocaleString()}`;

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

  // Build TOC rows — two columns for 30 chapters
  const tocRowsLeft = chapters.slice(0, 15).map((chapText, ci) => {
    const firstLine = chapText.split(/\n+/)[0] || '';
    const match = firstLine.match(/^Chapter (\d+):\s*(.+)$/);
    const num = match ? match[1] : String(ci + 1);
    const title = match ? match[2] : firstLine;
    return '<tr>' +
      '<td style="padding:5px 8px 5px 0;width:24px;font-size:8pt;color:#2d6a4f;font-weight:800;">' + num + '</td>' +
      '<td style="padding:5px 0;font-size:9pt;color:#1a1a2e;font-weight:600;">' + title + '</td>' +
      '</tr>';
  }).join('');

  const tocRowsRight = chapters.slice(15, 30).map((chapText, ci) => {
    const firstLine = chapText.split(/\n+/)[0] || '';
    const match = firstLine.match(/^Chapter (\d+):\s*(.+)$/);
    const num = match ? match[1] : String(ci + 16);
    const title = match ? match[2] : firstLine;
    return '<tr>' +
      '<td style="padding:5px 8px 5px 0;width:24px;font-size:8pt;color:#9ca3af;font-weight:800;">' + num + '</td>' +
      '<td style="padding:5px 0;font-size:9pt;color:#9ca3af;font-weight:600;font-style:italic;">' + title + ' ✦</td>' +
      '</tr>';
  }).join('');

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
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 13pt; line-height: 1.9; color: #1a1a2e; }

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
      <div class="cover-badge">A Growing Minds Original Story</div>
      <div class="cover-title-line1">${childName} and the</div>
      <div class="cover-title-main">${getMilestoneTitle(milestone)}</div>
      <div class="cover-divider"></div>
      <div class="cover-meta">Written for ${childName}, age ${age} &nbsp;·&nbsp; ${city}, ${region} &nbsp;·&nbsp; ${wordCount} words</div>
      <div class="cover-publisher">🌱 growingminds.io</div>
    </div>
  </div>

  <!-- TITLE PAGE -->
  <div class="title-page">
    <div>
      <div class="title-page-name">A story written for</div>
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
    <div style="margin-top:20px;padding:12px 16px;background:#f9fafb;border-radius:8px;font-family:Arial,sans-serif;font-size:8pt;color:#6b7280;">
      ✦ Chapters 16–30 are included in your printed hardcover book, arriving in 13–15 business days.
    </div>
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
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
      to: process.env.ADMIN_ALERT_EMAIL || "hello@growingminds.io",
      subject: `⚠️ ${subject}`,
      text: details
    });
    console.log(`Alert email sent: ${subject}`);
  } catch (e) {
    console.error(`Alert email failed to send: ${e.message}`);
  }
}

async function sendDeliveryEmail(email, childName, pdfBase64, child, tier, storyId) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { milestone, city, region } = child;
  const wordCount = `${(tier.chapCount * tier.minWords).toLocaleString()}–${(tier.chapCount * tier.maxWords).toLocaleString()}`;
  const storyTitle = `${childName} and the ${getMilestoneTitle(milestone)}`;

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
    to: email,
    bcc: "purchase@growingminds.io",
    subject: `📖 ${childName}'s story is on its way!`,
    attachments: [{ filename: `${childName}-story-part1.pdf`, content: pdfBase64 }],
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e;">
        <div style="background:#2d6a4f;padding:2rem;text-align:center;border-radius:12px 12px 0 0;">
          <h1 style="color:white;font-size:1.5rem;margin:0;">🌱 Growing Minds</h1>
        </div>
        <div style="background:#fefae0;padding:2rem;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;">
          <h2 style="color:#2d6a4f;">${storyTitle}</h2>
          <p>The first 10 chapters of ${childName}'s story are attached — start reading together tonight!</p>
          <p style="margin-top:1rem;color:#6b7280;font-size:.9rem;">The complete 30-chapter story arrives in your beautifully printed hardcover book within 13–15 business days.</p>

          <div style="background:white;border:2px solid #86efac;border-radius:12px;padding:1.2rem;margin-top:1.5rem;text-align:center;">
            <div style="font-size:.75rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#16a34a;margin-bottom:.4rem;">Your Family Story ID</div>
            <div style="font-family:monospace;font-size:1rem;font-weight:700;color:#14532d;background:#f0fdf4;border-radius:6px;padding:.4rem .8rem;display:inline-block;margin:.3rem 0;">${storyId}</div>
            <p style="font-size:.8rem;color:#4b7c5a;margin:.5rem 0 0 0;">Save this ID! Use it when ordering a sequel or a story for a sibling.</p>
          </div>

          <p style="color:#6b7280;font-size:.85rem;margin-top:1.5rem;">Questions? Email us at <a href="mailto:hello@growingminds.io" style="color:#2d6a4f;">hello@growingminds.io</a></p>
        </div>
      </div>
    `
  });
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
  // Store as JSON string with 2 hour expiry (plenty of time to finish)
  await redisRequest("SET", [`story:${storyId}`, JSON.stringify(allChapters), "EX", 7200]);
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
