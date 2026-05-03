// api/inngest.js — Full version with tiered stories + DALL-E 3 illustrations
const { serve } = require("inngest/node");
const { Inngest } = require("inngest");
const https = require("https");
const crypto = require("crypto");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const { Resend } = require("resend");
const { put, del } = require("@vercel/blob");

// Secure token for approve/regenerate links in admin email
function adminToken(storyId) {
  return crypto
    .createHmac("sha256", process.env.ADMIN_WEBHOOK_SECRET || "dev-secret")
    .update(storyId)
    .digest("hex")
    .slice(0, 24);
}

const inngest = new Inngest({
  id: "growingminds",
  eventKey: process.env.INNGEST_EVENT_KEY
});

// ── STORY TIERS BY AGE ──
function getStoryTier(age) {
  const a = parseInt(age);
  if (a <= 5) return { chapCount: 15, wordsPerChap: 500, maxTokensPerChap: 1000, imageCount: 15, imagesPerChap: 0, label: "illustrated chapter book" };
  if (a <= 9) return { chapCount: 20, wordsPerChap: 700, maxTokensPerChap: 1400, imageCount: 10, imagesPerChap: 0, label: "chapter book" };
  return       { chapCount: 30, wordsPerChap: 800, maxTokensPerChap: 1600, imageCount: 5,  imagesPerChap: 0, label: "novel" };
}

// ── ILLUSTRATION STYLE — three age-tiered styles ──
function getStyleGuideForAge(age) {
  const ageNum = parseInt(age) || 7;
  if (ageNum <= 7) {
    return "Fully painted children's picture book illustration. Warm soft lighting, rich vibrant colors, large expressive cartoon faces, simple inviting compositions. Smooth color fills with soft outlines — bright, cheerful, and playful. Like a modern animated picture book. NO heavy black ink lines. NO coloring-book line art. Fully colored throughout.";
  } else if (ageNum <= 11) {
    return "Detailed middle-grade chapter book illustration. Rich complex backgrounds, more realistic character proportions — like cover art for a middle-grade adventure novel. Warm but sophisticated color palette with depth and texture. Painterly digital art with expressive characters and dynamic compositions. NO flat baby cartoon style. Fully rendered with atmospheric lighting.";
  } else {
    return "Sophisticated graphic novel illustration. Realistic proportions, nuanced color palette, strong contrast and mood. Characters carry emotional depth. Cinematic painterly style — like a YA graphic novel or illustrated teen fiction. NO childlike cartoon style. Fully rendered with depth and atmosphere.";
  }
}

function getCoverStyleForAge(age) {
  const ageNum = parseInt(age) || 7;
  if (ageNum <= 7) {
    return "Bright cheerful children's picture book illustration. Smooth vibrant cartoon style with warm soft lighting — like a modern animated picture book. Rich saturated colors, large expressive face, simple inviting background. NO heavy black outlines. NO coloring-book style. Fully painted throughout.";
  } else if (ageNum <= 11) {
    return "Dynamic chapter book cover illustration. Rich detailed background, more realistic proportions — like a middle-grade adventure novel cover. Warm sophisticated color palette with depth and texture. Painterly digital art style. Expressive face full of personality. Fully rendered.";
  } else {
    return "Sophisticated graphic novel cover illustration. Realistic proportions, nuanced color palette with strong contrast and mood. Cinematic composition — like a YA graphic novel or illustrated teen fiction cover. Character carries emotional depth. Fully rendered with atmosphere and detail.";
  }
}

function getStyleGuide(age) {
  return getStyleGuideForAge(age);
}

// ── MAIN INNGEST FUNCTION ──
const generateStoryOrder = inngest.createFunction(
  { id: "generate-story-order", retries: 2, timeout: "60m" },
  { event: "order/completed" },
  async ({ event, step }) => {
    const { storyToken, childName, storyId, customerEmail, customDetails } = event.data;
    const childData = decodeStoryData(storyToken);
    if (!childData) throw new Error("Could not decode story token");
    // Merge customDetails from event (not stored in token to keep it short)
    if (customDetails) childData.customDetails = customDetails;

    const tier = getStoryTier(childData.age);
    console.log(`Starting ${tier.label} for ${childName} (${tier.chapCount} chapters)`);

    // Cache order metadata so /api/regenerate can re-fire without needing the original webhook
    await redisRequest("SET", [`storytoken:${storyId}`,    storyToken,       "EX", 604800]); // 7 days
    await redisRequest("SET", [`customeremail:${storyId}`, customerEmail,    "EX", 604800]);
    await redisRequest("SET", [`childname:${storyId}`,     childName,        "EX", 604800]);
    await redisRequest("SET", [`customdetails:${storyId}`, customDetails||"","EX", 604800]);

    // (no pre-parse step — nicknames are read directly from customDetails at generation time)

    // Build named characters list once — used by both generation prompts and correction passes
    const skipWords = new Set(["I","The","A","An","He","She","They","His","Her","Their","When","That","This","If","And","But","So","In","On","At","For","To","Of","My","Our","We","Is","Are","Was","Were","Will","Can","Not","No"]);
    const namedCharacters = [childName];
    if (childData.friend && childData.friend !== "none") {
      childData.friend.split(/,|\band\b/i).forEach(f => {
        const t = f.trim();
        if (t && !namedCharacters.includes(t)) namedCharacters.push(t);
      });
    }
    if (childData.customDetails) {
      const nameMatches = childData.customDetails.match(/\b[A-Z][a-z]{1,14}\b/g) || [];
      nameMatches.forEach(w => { if (!skipWords.has(w) && !namedCharacters.includes(w)) namedCharacters.push(w); });
    }
    childData.namedCharacters = namedCharacters;

    // Step 0b: Generate milestone guidance — research-informed approaches for this specific milestone
    // This shapes how the story models healthy coping and growth, woven naturally into the narrative
    const milestoneGuidance = await step.run("generate-milestone-guidance", async () => {
      const guidance = await generateMilestoneGuidance(childData.milestone, childData.age, childData.name);
      await redisRequest("SET", [`guidance:${storyId}`, guidance, "EX", 7200]);
      console.log(`Milestone guidance generated for "${childData.milestone}"`);
      return guidance;
    });

    // Step 0c: Parse custom details into a structured fact checklist
    // Haiku extracts every stated fact so the outline and chapters can be verified against them
    const parsedFacts = await step.run("parse-custom-details", async () => {
      if (!childData.customDetails) return null;
      const facts = await parseCustomDetails(childData.customDetails);
      if (facts) {
        await redisRequest("SET", [`facts:${storyId}`, facts, "EX", 7200]);
        childData.parsedFacts = facts;
      }
      return facts || null;
    });
    if (parsedFacts) childData.parsedFacts = parsedFacts;

    // Step 1: Generate chapter outline — pull preview story seed from Redis if available
    const rawOutline = await step.run("generate-outline", async () => {
      // Check for a story seed cached by generate-preview.js — if present, pass it to
      // generateOutline so the real story follows the same arc the customer saw in the preview.
      const seed = await redisRequest("GET", [`seed:${storyId}`]);
      if (seed) {
        console.log(`Using preview story seed for ${storyId}`);
        await redisRequest("DEL", [`seed:${storyId}`]);
      }
      const result = await generateOutline(childData, tier, seed || null, milestoneGuidance);
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(result), "EX", 7200]);
      console.log(`Saved outline with ${result.length} chapters to Redis`);
      return result;
    });

    // Step 1b: Sanitize outline — replace any named friend in a conflict/unkindness role with an unnamed character
    const sanitizedOutline = await step.run("sanitize-outline", async () => {
      const friendNames = namedCharacters.filter(n => n !== childName);
      if (friendNames.length === 0) return rawOutline;
      const sanitized = await sanitizeOutline(rawOutline, friendNames);
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(sanitized), "EX", 7200]);
      console.log(`Outline sanitized — ${sanitized.length} chapters`);
      return sanitized;
    });

    // Step 1c: Verify outline against parsed facts — ensure every stated custom detail is honoured
    const outline = await step.run("verify-outline", async () => {
      if (!parsedFacts || !childData.customDetails) return sanitizedOutline;
      const verified = await verifyOutlineAgainstFacts(sanitizedOutline, parsedFacts, childData.customDetails);
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(verified), "EX", 7200]);
      console.log(`Outline verified against custom facts — ${verified.length} chapters`);
      return verified;
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

        // Retrieve milestone guidance and parsed facts from Redis (generated before outline)
        const batchGuidance = await redisRequest("GET", [`guidance:${storyId}`]) || milestoneGuidance || "";
        const batchFacts = await redisRequest("GET", [`facts:${storyId}`]) || parsedFacts || null;
        if (batchFacts) childData.parsedFacts = batchFacts;

        // Generate this batch
        let batchChapters = await generateChapterBatch(childData, outline, start, end, priorChapters, tier, batchGuidance);

        // Deterministic regex enforcement: replace any unapproved diminutive with the full name
        batchChapters = batchChapters.map(ch =>
          enforceFullNamesRegex(ch, childData.namedCharacters, childData.parsedFacts)
        );

        // Correct any named-character kindness violations before saving
        batchChapters = await Promise.all(
          batchChapters.map(ch => correctKindness(ch, childData.namedCharacters))
        );


        // Save to Redis immediately
        await saveChaptersToRedis(storyId, priorChapters, batchChapters);

        return { saved: batchChapters.length };
      });
    }

    // Step 3: Generate illustrations in batches of 10
    let illustrations = {};
    console.log(`ILLUSTRATIONS CHECK: OPENAI_API_KEY=${!!process.env.OPENAI_API_KEY}, SKIP_ILLUSTRATIONS=${process.env.SKIP_ILLUSTRATIONS}`);
    if (process.env.OPENAI_API_KEY && process.env.SKIP_ILLUSTRATIONS !== "true") {
      const IMG_BATCH = 4; // Keep batches short — Vercel Pro caps function execution at 300s
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

      const { name, age, hair, hairLength, hairStyle, eye, gender, city, region } = childData;
      const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
      const genderDesc = gender === "girl" ? "girl" : gender === "boy" ? "boy" : "child";
      const styleGuide = getStyleGuide();

      // Locked physical description built directly from user form data — never overridden
      const hairLengthExpanded = hairLength === 'crew cut'        ? 'very short crew cut, buzzed close to the head'
        : hairLength === 'regular cut'     ? 'short regular cut, trimmed neatly above the ears'
        : hairLength === 'past the ears'   ? 'medium length, hanging past the ears'
        : hairLength === 'to the shoulders'? 'long, reaching all the way to the shoulders'
        : hairLength === 'long'            ? 'very long, flowing well past the shoulders'
        : hairLength === 'short'           ? 'very short, close-cropped, above the ears'
        : hairLength === 'medium'          ? 'medium-length, chin to shoulder'
        : hairLength || '';
      const hairDescExpanded = [hairLengthExpanded, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
      // Keep gender — needed for correct character rendering. For long-haired boys, add explicit note.
      const lockedCharDesc = `a ${age}-year-old ${genderDesc} with ${hairDescExpanded} hair and ${eye} eyes`;
      const longHairBoyNote = (genderDesc === 'boy' && (hairLength === 'long' || hairLength === 'to the shoulders'))
        ? ` IMPORTANT: ${name} is a BOY with long hair — render with clearly boyish/masculine facial features (strong brow, boyish jaw, masculine face). Do NOT make this character look like a girl.`
        : '';

      // Step B: Generate cover image
      await step.run("generate-cover-and-character-sheet-v4", async () => {
        // Pick a dramatic hero moment from ~65% through the story (climax area)
        const heroMomentIdx = Math.min(Math.floor(freshOutline.length * 0.65), freshOutline.length - 1);
        const heroMomentChap = freshOutline[heroMomentIdx] || freshOutline[0];
        const wavyNote = hairStyle && (hairStyle.toLowerCase().includes('wavy') || hairStyle.toLowerCase().includes('curly'))
          ? ` MANDATORY HAIR TEXTURE: ${name}'s hair is ${hairStyle.toUpperCase()} — every strand must show visible ${hairStyle} texture. This hair is NOT straight. Do NOT render straight hair. Waves or curls must be clearly visible from root to tip.`
          : '';

        // Tiered age descriptor for cover — same approach as secondary character age enforcement
        const coverAgeNum = parseInt(age);
        const coverAgeAppearance =
          coverAgeNum <= 2  ? `a toddler — tiny body, very chubby round face, barely walking height, clearly a baby or toddler` :
          coverAgeNum <= 4  ? `a preschooler — small, round babyish face, very short, clearly a young toddler-age child` :
          coverAgeNum <= 6  ? `a kindergarten-age child — small compact body, round young face, clearly a little kid, very small compared to an adult` :
          coverAgeNum <= 8  ? `a 2nd–3rd grade child — young elementary school age, round face, clearly a child, small body` :
          coverAgeNum <= 11 ? `an older elementary child — taller, leaner face, but unmistakably still a child, NOT a teenager` :
          coverAgeNum <= 14 ? `a middle-school-aged child — approaching adolescence but clearly still a kid, NOT an adult` :
                              `a teenager or adult`;

        const coverStyle = getCoverStyleForAge(age);
        const coverPrompt = `${coverStyle}

CRITICAL AGE: ${name} is ${age} years old — they MUST look like ${coverAgeAppearance}. Do NOT render ${name} at the wrong age. Age ${age} — correct body proportions and face shape for a real ${age}-year-old.

Character: ${name}, ${lockedCharDesc}.${longHairBoyNote} HAIR: ${name}'s hair is ${hair}-colored, ${hairStyle ? `${hairStyle}, ` : ''}${hairLengthExpanded}. Length: ${hairLengthExpanded} — do not shorten it.${wavyNote} ${name} stands smiling in a wide open ${region} outdoor scene. Single continuous scene filling the entire image edge to edge — no insets, no borders, no color swatches, no paint palettes, no art supplies. No text or words anywhere.`;
        const coverUrl = await callDallE(coverPrompt);
        const coverBytes = await fetchImageBytes(coverUrl);
        const blob = await put(`illustrations/${storyId}/0-0.jpg`, coverBytes, { access: 'public', contentType: 'image/jpeg' });
        await saveIllustrationsToRedis(storyId, { '0-0': blob.url });
        // Store cover URL separately with a 7-day TTL — the illustration key (2h) may expire
        // before notify-admin runs on long stories. This key is never deleted by cleanup.
        await redisRequest("SET", [`cover:${storyId}`, blob.url, "EX", 604800]);
        console.log(`Cover image generated: ${blob.url.slice(0, 60)}`);
      });

      // Step C: Generate remaining illustrations using fal.ai instant-character
      // The cover image is used as the character reference so all chapter images match
      const remainingKeys = allImageKeys.filter(k => k !== '0-0');
      for (let b = 0; b < remainingKeys.length; b++) {
        await step.run(`generate-illustration-fal-${b + 1}`, async () => {
          const key = remainingKeys[b];
          const [ci] = key.split('-').map(Number);
          const chap = freshOutline[ci];
          console.log(`Generating illustration ${b + 1}/${remainingKeys.length}: key ${key}`);

          // Get the cover Blob URL as the character reference
          const coverBlobUrl = await redisRequest("GET", [`cover:${storyId}`]);
          if (!coverBlobUrl) throw new Error(`cover:${storyId} not found in Redis — cannot generate character-consistent image`);

          // Extract a specific visual scene from the actual written chapter text
          // Fall back to outline imagePrompt if chapter text isn't available
          const allChapters = await getChaptersFromRedis(storyId);
          const chapterText = allChapters[ci] || null;
          const visualScene = chapterText
            ? await extractScenePrompt(chapterText, name, age, city, region)
            : (chap?.imagePrompt || `${name} having fun outdoors in ${city}`);

          // Age-specific illustration style directive
          const ageNum = parseInt(age);
          const mainAgeAppearance =
            ageNum <= 2  ? `a toddler — tiny body, very chubby round face, barely walking height` :
            ageNum <= 4  ? `a preschooler — small, round babyish face, very short, clearly a young toddler-age child` :
            ageNum <= 6  ? `a kindergarten-age child — small compact body, round young face, clearly a little kid` :
            ageNum <= 8  ? `a 2nd–3rd grade child — young elementary school age, round face, small body, clearly a child` :
            ageNum <= 11 ? `an older elementary child — taller but unmistakably still a child, NOT a teenager` :
            ageNum <= 14 ? `a middle-school-aged child — clearly still a kid, NOT an adult` :
                           `a teenager or adult`;
          const illustrationStyle = ageNum <= 7
            ? `Large expressive facial emotions and clear body language. Simple, uncluttered composition — one clear action in focus. The illustration should make the scene immediately readable without the text.`
            : ageNum <= 10
            ? `Expressive character faces with personality and humor. Spot-illustration feel — tight on the characters, with enough background to set the scene. Include one small visual detail that adds humor or reveals character beyond what the text says.`
            : `Atmospheric and cinematic. Detailed environment that captures the mood of the scene. Character expression conveys internal emotion — not just what they're doing but how they feel about it.`;

          // Main character hair texture note
          const mainCharHairNote = hairStyle
            ? `${hairStyle} ${hairLengthExpanded} ${hair}-colored hair${hairStyle.toLowerCase().includes('wavy') || hairStyle.toLowerCase().includes('curly') ? ` — IMPORTANT: visibly ${hairStyle}, NOT straight` : ''}`
            : `${hairLengthExpanded} ${hair}-colored hair`;

          const sceneStyleGuide = getStyleGuideForAge(age);
          const scenePrompt = `${sceneStyleGuide} Scene: ${visualScene} Setting: ${city}, ${region}. CRITICAL AGE: The main character is ${age} years old — must look like ${mainAgeAppearance}. Main character has ${mainCharHairNote}. ${illustrationStyle} IMPORTANT: The main character is the ONLY person in this illustration — no other people, no secondary characters, no adults, no children in the background. No text anywhere.`;

          const imageBytes = await callFalInstantCharacter(coverBlobUrl, scenePrompt);
          const blob = await put(`illustrations/${storyId}/${key}.jpg`, imageBytes, { access: 'public', contentType: 'image/jpeg' });
          await saveIllustrationsToRedis(storyId, { [key]: blob.url });
          console.log(`Image ${key} generated with fal.ai instant-character: ${blob.url.slice(0, 60)}`);
          return { key, saved: true };
        });
      }
    } else {
      console.log("Skipping illustrations");
    }

    // Step 4: Generate PDF with first 10 chapters only and store to Blob
    const pdfBlobUrl = await step.run("create-pdf-v5", async () => {
      console.log(`STARTING PDF GENERATION v4`);
      const chapters = await getChaptersFromRedis(storyId);
      const illustrationUrls = await getIllustrationsFromRedis(storyId);
      console.log(`PDF v4: ${chapters.length} chapters, ${Object.keys(illustrationUrls).length} illustration URLs`);
      console.log(`PDF v4: illustration keys: ${Object.keys(illustrationUrls).join(', ')}`);
      // Pass Blob URLs directly — PDFShift fetches images by URL, no need to download/base64 encode
      const pdfBase64 = await generatePDF(childName, chapters.slice(0, 10), childData, tier, illustrationUrls);
      // Store PDF to Blob and return only the URL to avoid Inngest output_too_large
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const blob = await put(`pdfs/${storyId}/story-part1.pdf`, pdfBuffer, {
        access: 'public',
        contentType: 'application/pdf'
      });
      console.log(`PDF v3: stored to Blob: ${blob.url.slice(0, 60)}`);
      return blob.url;
    });
    // Step 5: Generate full 30-chapter print PDF — stored permanently in Blob
    const fullBookUrl = await step.run("create-full-book-v1", async () => {
      const allChapters = await getChaptersFromRedis(storyId);
      const illustrationUrls = await getIllustrationsFromRedis(storyId);

      // Pre-fetch every illustration from Blob and base64-encode individually.
      // Per-image try/catch means one failure never kills the whole PDF.
      const illustrationsB64 = {};
      for (const [key, url] of Object.entries(illustrationUrls)) {
        try {
          const bytes = await fetchImageBytes(url);
          illustrationsB64[key] = `data:image/jpeg;base64,${bytes.toString('base64')}`;
          console.log(`Full book image ${key} encoded (${Math.round(bytes.length / 1024)}KB)`);
        } catch(e) {
          console.error(`Full book: image ${key} fetch failed — skipping: ${e.message}`);
        }
      }
      console.log(`Full book: embedded ${Object.keys(illustrationsB64).length}/${Object.keys(illustrationUrls).length} images`);

      const pdfBase64 = await generateFullBookPDF(childName, allChapters, childData, tier, illustrationsB64);
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const blob = await put(`pdfs/${storyId}/full-book.pdf`, pdfBuffer, {
        access: 'public',
        contentType: 'application/pdf'
      });
      console.log(`Full book PDF stored permanently: ${blob.url.slice(0, 80)} (${Math.round(pdfBuffer.length / 1024)}KB)`);
      return blob.url;
    });

    // Step 7: Save full story to Airtable for training data
    await step.run("save-story", async () => {
      console.log(`Saving story to Airtable for ${childName}`);
      const allChapters = await getChaptersFromRedis(storyId);
      await saveStoryToAirtable(storyId, customerEmail, childName, childData, allChapters, fullBookUrl);
    });

    // Step 7b: Notify admin — story preview + approve/regenerate buttons
    await step.run("notify-admin", async () => {
      const coverImageUrl = await redisRequest("GET", [`cover:${storyId}`]) || null;
      const chapters = await getChaptersFromRedis(storyId);
      const previewChapter = chapters && chapters[0] ? chapters[0].text || chapters[0] : null;
      const token = adminToken(storyId);
      await sendAdminNotificationEmail(storyId, customerEmail, childName, childData, tier, fullBookUrl, coverImageUrl, previewChapter, token);
      await redisRequest("DEL", [`cover:${storyId}`]);
    });

    // Step 7c: Wait up to 15 minutes for admin approval — auto-sends if no action taken
    await step.waitForEvent("wait-for-approval", {
      event: "story/approved",
      match: "data.storyId",
      timeout: "15m"
    });

    // Step 7d: Send customer email — skip if admin triggered a regeneration
    await step.run("send-email", async () => {
      const skip = await redisRequest("GET", [`skip-delivery:${storyId}`]);
      if (skip) {
        console.log(`Delivery skipped for ${storyId} — regeneration was triggered`);
        await redisRequest("DEL", [`skip-delivery:${storyId}`]);
        return;
      }
      console.log(`Sending email to ${customerEmail}`);
      const pdfBytes = await fetchImageBytes(pdfBlobUrl);
      const pdfBase64 = pdfBytes.toString('base64');
      await sendDeliveryEmail(customerEmail, childName, pdfBase64, childData, tier, storyId);
    });

    // Step 8: Clean up Redis and Blob storage
    await step.run("cleanup", async () => {
      await deleteChaptersFromRedis(storyId);
      // Delete illustration URLs from Redis and files from Blob
      try {
        const imgKeys = await redisRequest("KEYS", [`img:${storyId}:*`]);
        if (imgKeys && imgKeys.length > 0) {
          const urlsToDelete = [];
          for (const k of imgKeys) {
            const url = await redisRequest("GET", [k]);
            // Keep the cover Blob permanently — identify by Redis key, not URL string,
            // because Vercel Blob appends a random hash so the filename won't be "0-0.jpg"
            const isCover = k === `img:${storyId}:0-0`;
            if (url && !isCover) urlsToDelete.push(url);
            await redisRequest("DEL", [k]);
          }
          if (urlsToDelete.length > 0) await del(urlsToDelete);
        }
      } catch(e) { console.error("Illustration cleanup error:", e.message); }
      await redisRequest("DEL", [`outline:${storyId}`]);

      await redisRequest("DEL", [`storytoken:${storyId}`]);
      await redisRequest("DEL", [`customeremail:${storyId}`]);
      await redisRequest("DEL", [`childname:${storyId}`]);
      await redisRequest("DEL", [`customdetails:${storyId}`]);
      // Delete the temporary PDF from Blob
      try { await del([pdfBlobUrl]); } catch(e) { console.error("PDF blob cleanup error:", e.message); }
      console.log(`Cleaned up Redis and Blob for ${storyId}`);
    });

    console.log(`✅ Complete for ${childName}`);
    return { success: true, childName, tier: tier.label };
  }
);

// ════════════════════════════════════════════
// PREVIEW — generate chapters 1-3 + email
// ════════════════════════════════════════════

const generatePreviewChapters = inngest.createFunction(
  { id: "generate-preview-chapters", retries: 2, timeout: "45m" },
  { event: "preview/completed" },
  async ({ event, step }) => {
    const { storyToken, childName, storyId, customerEmail, customDetails } = event.data;
    const childData = decodeStoryData(storyToken);
    if (!childData) throw new Error("Could not decode story token");
    if (customDetails) childData.customDetails = customDetails;

    const tier = getStoryTier(childData.age);
    const PREVIEW_CHAPS = 3;
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://growingminds.io';

    // Cache everything with 7-day TTLs — must survive until upgrade payment
    await redisRequest("SET", [`storytoken:${storyId}`,    storyToken,        "EX", 604800]);
    await redisRequest("SET", [`customeremail:${storyId}`, customerEmail,     "EX", 604800]);
    await redisRequest("SET", [`childname:${storyId}`,     childName,         "EX", 604800]);
    await redisRequest("SET", [`customdetails:${storyId}`, customDetails||"", "EX", 604800]);
    await redisRequest("SET", [`preview_paid:${storyId}`,  "true",            "EX", 604800]);

    // Named characters list
    const skipWords = new Set(["I","The","A","An","He","She","They","His","Her","Their","When","That","This","If","And","But","So","In","On","At","For","To","Of","My","Our","We","Is","Are","Was","Were","Will","Can","Not","No"]);
    const namedCharacters = [childName];
    if (childData.friend && childData.friend !== "none") {
      childData.friend.split(/,|\band\b/i).forEach(f => { const t = f.trim(); if (t && !namedCharacters.includes(t)) namedCharacters.push(t); });
    }
    if (childData.customDetails) {
      const nameMatches = childData.customDetails.match(/\b[A-Z][a-z]{1,14}\b/g) || [];
      nameMatches.forEach(w => { if (!skipWords.has(w) && !namedCharacters.includes(w)) namedCharacters.push(w); });
    }
    childData.namedCharacters = namedCharacters;

    // Step 0b: Milestone guidance
    const milestoneGuidance = await step.run("preview-milestone-guidance", async () => {
      const guidance = await generateMilestoneGuidance(childData.milestone, childData.age, childData.name);
      await redisRequest("SET", [`guidance:${storyId}`, guidance, "EX", 604800]);
      return guidance;
    });

    // Step 0c: Parse custom details
    const parsedFacts = await step.run("preview-parse-custom-details", async () => {
      if (!childData.customDetails) return null;
      const facts = await parseCustomDetails(childData.customDetails);
      if (facts) await redisRequest("SET", [`facts:${storyId}`, facts, "EX", 604800]);
      return facts || null;
    });
    if (parsedFacts) childData.parsedFacts = parsedFacts;

    // Step 1: Generate full outline (needed for narrative coherence even in preview)
    const rawOutline = await step.run("preview-generate-outline", async () => {
      const result = await generateOutline(childData, tier, null, milestoneGuidance);
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(result), "EX", 604800]);
      return result;
    });

    const sanitizedOutline = await step.run("preview-sanitize-outline", async () => {
      const friendNames = namedCharacters.filter(n => n !== childName);
      if (friendNames.length === 0) return rawOutline;
      const sanitized = await sanitizeOutline(rawOutline, friendNames);
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(sanitized), "EX", 604800]);
      return sanitized;
    });

    const outline = await step.run("preview-verify-outline", async () => {
      if (!parsedFacts || !childData.customDetails) return sanitizedOutline;
      const verified = await verifyOutlineAgainstFacts(sanitizedOutline, parsedFacts, childData.customDetails);
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(verified), "EX", 604800]);
      return verified;
    });

    // Step 2: Generate chapters 1-3
    await step.run("preview-generate-chapters", async () => {
      const priorChapters = await getChaptersFromRedis(storyId);
      const guidance = await redisRequest("GET", [`guidance:${storyId}`]) || milestoneGuidance;
      const facts = await redisRequest("GET", [`facts:${storyId}`]);
      if (facts) childData.parsedFacts = facts;

      let chapters = await generateChapterBatch(childData, outline, 0, PREVIEW_CHAPS, priorChapters, tier, guidance);
      chapters = chapters.map(ch => enforceFullNamesRegex(ch, childData.namedCharacters, childData.parsedFacts));
      chapters = await Promise.all(chapters.map(ch => correctKindness(ch, childData.namedCharacters)));

      const all = [...priorChapters, ...chapters];
      await redisRequest("SET", [`story:${storyId}`, JSON.stringify(all), "EX", 604800]);
    });

    // Step 3: Illustrations — cover + scene images for chapters 1-3
    const { name, age, hair, hairLength, hairStyle, eye, gender, city, region } = childData;
    const genderDesc = gender === "girl" ? "girl" : gender === "boy" ? "boy" : "child";
    const styleGuide = getStyleGuide();
    const hairLengthExpanded =
      hairLength === 'crew cut'        ? 'very short crew cut, buzzed close to the head'
      : hairLength === 'regular cut'   ? 'short regular cut, trimmed neatly above the ears'
      : hairLength === 'past the ears' ? 'medium length, hanging past the ears'
      : hairLength === 'to the shoulders' ? 'long, reaching all the way to the shoulders'
      : hairLength === 'long'          ? 'very long, flowing well past the shoulders'
      : hairLength === 'short'         ? 'very short, close-cropped, above the ears'
      : hairLength === 'medium'        ? 'medium-length, chin to shoulder'
      : hairLength || '';
    const hairDescExpanded = [hairLengthExpanded, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
    const lockedCharDesc = `a ${age}-year-old ${genderDesc} with ${hairDescExpanded} hair and ${eye} eyes`;
    const longHairBoyNote = (genderDesc === 'boy' && (hairLength === 'long' || hairLength === 'to the shoulders'))
      ? ` IMPORTANT: ${name} is a BOY with long hair — render with clearly boyish/masculine facial features.`
      : '';

    // Cover image
    await step.run("preview-cover", async () => {
      const wavyNote = hairStyle && (hairStyle.toLowerCase().includes('wavy') || hairStyle.toLowerCase().includes('curly'))
        ? ` MANDATORY HAIR TEXTURE: ${name}'s hair is ${hairStyle.toUpperCase()} — every strand must show visible ${hairStyle} texture.`
        : '';
      const coverAgeNum = parseInt(age);
      const coverAgeAppearance =
        coverAgeNum <= 2  ? `a toddler — tiny body, very chubby round face, barely walking height` :
        coverAgeNum <= 4  ? `a preschooler — small, round babyish face, very short, clearly a young toddler-age child` :
        coverAgeNum <= 6  ? `a kindergarten-age child — small compact body, round young face, clearly a little kid` :
        coverAgeNum <= 8  ? `a 2nd–3rd grade child — young elementary school age, round face, small body` :
        coverAgeNum <= 11 ? `an older elementary child — taller but unmistakably still a child, NOT a teenager` :
        coverAgeNum <= 14 ? `a middle-school-aged child — clearly still a kid, NOT an adult` :
                            `a teenager or adult`;
      const coverStyle = getCoverStyleForAge(age);
      const coverPrompt = `${coverStyle}

CRITICAL AGE: ${name} is ${age} years old — they MUST look like ${coverAgeAppearance}. Do NOT render ${name} at the wrong age. Age ${age} — correct body proportions and face shape for a real ${age}-year-old.

Character: ${name}, ${lockedCharDesc}.${longHairBoyNote} HAIR: ${name}'s hair is ${hair}-colored, ${hairStyle ? `${hairStyle}, ` : ''}${hairLengthExpanded}.${wavyNote} ${name} stands smiling in a wide open ${region} outdoor scene. Single continuous scene filling the entire image edge to edge — no insets, no borders, no color swatches, no paint palettes, no art supplies. No text or words anywhere.`;
      const coverUrl = await callDallE(coverPrompt);
      const coverBytes = await fetchImageBytes(coverUrl);
      const blob = await put(`illustrations/${storyId}/0-0.jpg`, coverBytes, { access: 'public', contentType: 'image/jpeg' });
      await redisRequest("SET", [`cover:${storyId}`, blob.url, "EX", 604800]);
      await redisRequest("SET", [`img:${storyId}:0-0`, blob.url, "EX", 604800]);
    });

    // Scene illustrations for chapters 1-3
    const freshOutlineForImgs = JSON.parse(await redisRequest("GET", [`outline:${storyId}`]) || '[]');
    const step2 = Math.floor(freshOutlineForImgs.length / tier.imageCount);
    const allImageKeys = Array.from({ length: tier.imageCount }, (_, i) =>
      `${Math.min(i * step2, freshOutlineForImgs.length - 1)}-0`
    );
    if (!allImageKeys.includes('0-0')) allImageKeys[0] = '0-0';
    // Only generate images whose chapter index falls within the preview (1-3)
    const previewSceneKeys = allImageKeys.filter(k => {
      const ci = parseInt(k.split('-')[0]);
      return ci >= 1 && ci <= PREVIEW_CHAPS;
    });

    for (let b = 0; b < previewSceneKeys.length; b++) {
      await step.run(`preview-illustration-${b + 1}`, async () => {
        const key = previewSceneKeys[b];
        const ci = parseInt(key.split('-')[0]);
        const chap = freshOutlineForImgs[ci];
        const coverBlobUrl = await redisRequest("GET", [`cover:${storyId}`]);
        if (!coverBlobUrl) throw new Error("Cover not found");

        const allChapters = await getChaptersFromRedis(storyId);
        const chapterText = allChapters[ci] || null;
        const visualScene = chapterText
          ? await extractScenePrompt(chapterText, name, age, city, region)
          : (chap?.imagePrompt || `${name} having a great time outdoors in ${city}`);

        const ageNum = parseInt(age);
        const mainAgeAppearance =
          ageNum <= 2  ? `a toddler — tiny body, very chubby round face` :
          ageNum <= 4  ? `a preschooler — small, round babyish face, very short` :
          ageNum <= 6  ? `a kindergarten-age child — small compact body, round young face, clearly a little kid` :
          ageNum <= 8  ? `a 2nd–3rd grade child — young elementary school age, round face, small body` :
          ageNum <= 11 ? `an older elementary child — taller but unmistakably still a child` :
          ageNum <= 14 ? `a middle-school-aged child — clearly still a kid` :
                         `a teenager or adult`;
        const illustrationStyle = ageNum <= 7
          ? `Large expressive facial emotions and clear body language. Simple, uncluttered composition.`
          : ageNum <= 10
          ? `Expressive character faces with personality and humor.`
          : `Atmospheric and cinematic. Character expression conveys internal emotion.`;
        const mainCharHairNote = hairStyle
          ? `${hairStyle} ${hairLengthExpanded} ${hair}-colored hair${hairStyle.toLowerCase().includes('wavy') || hairStyle.toLowerCase().includes('curly') ? ` — IMPORTANT: visibly ${hairStyle}, NOT straight` : ''}`
          : `${hairLengthExpanded} ${hair}-colored hair`;
        const sceneStyleGuide = getStyleGuideForAge(age);
        const scenePrompt = `${sceneStyleGuide} Scene: ${visualScene} Setting: ${city}, ${region}. CRITICAL AGE: The main character is ${age} years old — must look like ${mainAgeAppearance}. Main character has ${mainCharHairNote}. ${illustrationStyle} IMPORTANT: The main character is the ONLY person in this illustration — no other people, no secondary characters, no adults, no children in the background. No text anywhere.`;

        const imageBytes = await callFalInstantCharacter(coverBlobUrl, scenePrompt);
        const blob = await put(`illustrations/${storyId}/${key}.jpg`, imageBytes, { access: 'public', contentType: 'image/jpeg' });
        await redisRequest("SET", [`img:${storyId}:${key}`, blob.url, "EX", 604800]);
      });
    }

    // Step 4: Send preview email with chapters + upgrade CTA
    await step.run("preview-send-email", async () => {
      const chapters = await getChaptersFromRedis(storyId);
      const coverUrl = await redisRequest("GET", [`cover:${storyId}`]);
      const upgradeUrl = `${baseUrl}/upgrade.html?sid=${storyId}&name=${encodeURIComponent(childName)}`;
      await sendPreviewEmail(customerEmail, childName, chapters, coverUrl, storyId, childData, upgradeUrl);
    });

    console.log(`✅ Preview complete for ${childName} — ${PREVIEW_CHAPS} chapters emailed`);
    return { success: true, childName, chapters: PREVIEW_CHAPS };
  }
);

// ════════════════════════════════════════════
// UPGRADE — generate remaining chapters + full book
// ════════════════════════════════════════════

const generateRemainingChapters = inngest.createFunction(
  { id: "generate-remaining-chapters", retries: 2, timeout: "60m" },
  { event: "upgrade/completed" },
  async ({ event, step }) => {
    const { storyId, childName, customerEmail, shippingAddress } = event.data;

    // Load everything from Redis — preview function stored it all with 7-day TTLs
    const storyToken = await redisRequest("GET", [`storytoken:${storyId}`]);
    if (!storyToken) throw new Error(`No storyToken in Redis for ${storyId} — preview may have expired`);

    const childData = decodeStoryData(storyToken);
    if (!childData) throw new Error("Could not decode story token");

    const customDetails = await redisRequest("GET", [`customdetails:${storyId}`]);
    if (customDetails) childData.customDetails = customDetails;

    const tier = getStoryTier(childData.age);
    const PREVIEW_CHAPS = 3;

    // Reload named characters
    const skipWords = new Set(["I","The","A","An","He","She","They","His","Her","Their","When","That","This","If","And","But","So","In","On","At","For","To","Of","My","Our","We","Is","Are","Was","Were","Will","Can","Not","No"]);
    const namedCharacters = [childName];
    if (childData.friend && childData.friend !== "none") {
      childData.friend.split(/,|\band\b/i).forEach(f => { const t = f.trim(); if (t && !namedCharacters.includes(t)) namedCharacters.push(t); });
    }
    if (childData.customDetails) {
      const nameMatches = childData.customDetails.match(/\b[A-Z][a-z]{1,14}\b/g) || [];
      nameMatches.forEach(w => { if (!skipWords.has(w) && !namedCharacters.includes(w)) namedCharacters.push(w); });
    }
    childData.namedCharacters = namedCharacters;

    // Load stored outline and parsedFacts
    const outlineRaw = await redisRequest("GET", [`outline:${storyId}`]);
    const outline = outlineRaw ? JSON.parse(outlineRaw) : null;
    if (!outline) throw new Error(`No outline in Redis for ${storyId}`);
    const parsedFacts = await redisRequest("GET", [`facts:${storyId}`]);
    if (parsedFacts) childData.parsedFacts = parsedFacts;

    console.log(`Upgrade: generating chapters ${PREVIEW_CHAPS + 1}–${tier.chapCount} for ${childName}`);

    // Step 1: Generate remaining chapters in batches of 4
    const BATCH_SIZE = 4;
    const startChap = PREVIEW_CHAPS; // 0-indexed: chapters already done are indices 0,1,2
    const batches = Math.ceil((tier.chapCount - startChap) / BATCH_SIZE);

    for (let b = 0; b < batches; b++) {
      await step.run(`upgrade-batch-${b + 1}`, async () => {
        const start = startChap + b * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, tier.chapCount);
        console.log(`Upgrade batch ${b + 1}/${batches}: chapters ${start + 1}–${end}`);

        const priorChapters = await getChaptersFromRedis(storyId);
        const guidance = await redisRequest("GET", [`guidance:${storyId}`]) || "";
        const facts = await redisRequest("GET", [`facts:${storyId}`]);
        if (facts) childData.parsedFacts = facts;

        let chapters = await generateChapterBatch(childData, outline, start, end, priorChapters, tier, guidance);
        chapters = chapters.map(ch => enforceFullNamesRegex(ch, childData.namedCharacters, childData.parsedFacts));
        chapters = await Promise.all(chapters.map(ch => correctKindness(ch, childData.namedCharacters)));

        // Extend Redis TTL and save (append to existing chapters 1-3)
        const all = [...priorChapters, ...chapters];
        await redisRequest("SET", [`story:${storyId}`, JSON.stringify(all), "EX", 604800]);
        return { saved: chapters.length };
      });
    }

    // Step 2: Generate remaining illustrations
    const { name, age, hair, hairLength, hairStyle, eye, gender, city, region } = childData;
    const genderDesc = gender === "girl" ? "girl" : gender === "boy" ? "boy" : "child";
    const hairLengthExpanded =
      hairLength === 'crew cut'        ? 'very short crew cut, buzzed close to the head'
      : hairLength === 'regular cut'   ? 'short regular cut, trimmed neatly above the ears'
      : hairLength === 'past the ears' ? 'medium length, hanging past the ears'
      : hairLength === 'to the shoulders' ? 'long, reaching all the way to the shoulders'
      : hairLength === 'long'          ? 'very long, flowing well past the shoulders'
      : hairLength === 'short'         ? 'very short, close-cropped, above the ears'
      : hairLength === 'medium'        ? 'medium-length, chin to shoulder'
      : hairLength || '';

    if (process.env.OPENAI_API_KEY && process.env.SKIP_ILLUSTRATIONS !== "true") {
      const step2 = Math.floor(outline.length / tier.imageCount);
      const allImageKeys = Array.from({ length: tier.imageCount }, (_, i) =>
        `${Math.min(i * step2, outline.length - 1)}-0`
      );
      if (!allImageKeys.includes('0-0')) allImageKeys[0] = '0-0';

      // Only generate keys NOT already in Redis (preview already made 0-0 + first few scene keys)
      const upgradeKeys = [];
      for (const key of allImageKeys) {
        const exists = await redisRequest("GET", [`img:${storyId}:${key}`]);
        if (!exists) upgradeKeys.push(key);
      }
      console.log(`Upgrade: generating ${upgradeKeys.length} remaining illustrations`);

      for (let b = 0; b < upgradeKeys.length; b++) {
        await step.run(`upgrade-illustration-${b + 1}`, async () => {
          const key = upgradeKeys[b];
          const ci = parseInt(key.split('-')[0]);
          const chap = outline[ci];
          const coverBlobUrl = await redisRequest("GET", [`cover:${storyId}`]);
          if (!coverBlobUrl) throw new Error("Cover not found in Redis");

          const allChapters = await getChaptersFromRedis(storyId);
          const chapterText = allChapters[ci] || null;
          const visualScene = chapterText
            ? await extractScenePrompt(chapterText, name, age, city, region)
            : (chap?.imagePrompt || `${name} on an adventure in ${city}`);

          const ageNum = parseInt(age);
          const mainAgeAppearance =
            ageNum <= 2  ? `a toddler — tiny body, very chubby round face` :
            ageNum <= 4  ? `a preschooler — small, round babyish face, very short` :
            ageNum <= 6  ? `a kindergarten-age child — small compact body, round young face` :
            ageNum <= 8  ? `a 2nd–3rd grade child — young elementary school age, round face` :
            ageNum <= 11 ? `an older elementary child — taller but unmistakably still a child` :
            ageNum <= 14 ? `a middle-school-aged child — clearly still a kid` :
                           `a teenager or adult`;
          const illustrationStyle = ageNum <= 7 ? `Large expressive facial emotions. Simple, uncluttered composition.` : ageNum <= 10 ? `Expressive character faces with personality and humor.` : `Atmospheric and cinematic.`;
          const mainCharHairNote = hairStyle
            ? `${hairStyle} ${hairLengthExpanded} ${hair}-colored hair${hairStyle.toLowerCase().includes('wavy') || hairStyle.toLowerCase().includes('curly') ? ` — visibly ${hairStyle}, NOT straight` : ''}`
            : `${hairLengthExpanded} ${hair}-colored hair`;
          const sceneStyleGuide = getStyleGuideForAge(age);
          const scenePrompt = `${sceneStyleGuide} Scene: ${visualScene} Setting: ${city}, ${region}. CRITICAL AGE: The main character is ${age} years old — must look like ${mainAgeAppearance}. Main character has ${mainCharHairNote}. ${illustrationStyle} IMPORTANT: The main character is the ONLY person in this illustration — no other people, no secondary characters, no adults, no children in the background. No text anywhere.`;

          const imageBytes = await callFalInstantCharacter(coverBlobUrl, scenePrompt);
          const blob = await put(`illustrations/${storyId}/${key}.jpg`, imageBytes, { access: 'public', contentType: 'image/jpeg' });
          await redisRequest("SET", [`img:${storyId}:${key}`, blob.url, "EX", 604800]);
        });
      }
    }

    // Step 3: Build preview PDF (first 10 chapters) and full book PDF
    const pdfBlobUrl = await step.run("upgrade-create-pdf", async () => {
      const chapters = await getChaptersFromRedis(storyId);
      const illustrationUrls = await getIllustrationsFromRedis(storyId);
      const pdfBase64 = await generatePDF(childName, chapters.slice(0, 10), childData, tier, illustrationUrls);
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const blob = await put(`pdfs/${storyId}/story-part1.pdf`, pdfBuffer, { access: 'public', contentType: 'application/pdf' });
      return blob.url;
    });

    const fullBookUrl = await step.run("upgrade-create-full-book", async () => {
      const allChapters = await getChaptersFromRedis(storyId);
      const illustrationUrls = await getIllustrationsFromRedis(storyId);
      const illustrationsB64 = {};
      for (const [key, url] of Object.entries(illustrationUrls)) {
        try {
          const bytes = await fetchImageBytes(url);
          illustrationsB64[key] = `data:image/jpeg;base64,${bytes.toString('base64')}`;
        } catch(e) { console.error(`Full book image ${key} failed: ${e.message}`); }
      }
      const pdfBase64 = await generateFullBookPDF(childName, allChapters, childData, tier, illustrationsB64);
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const blob = await put(`pdfs/${storyId}/full-book.pdf`, pdfBuffer, { access: 'public', contentType: 'application/pdf' });
      return blob.url;
    });

    // Step 4: Save to Airtable
    await step.run("upgrade-save-story", async () => {
      const allChapters = await getChaptersFromRedis(storyId);
      await saveStoryToAirtable(storyId, customerEmail, childName, childData, allChapters, fullBookUrl);
    });

    // Step 5: Admin notification
    await step.run("upgrade-notify-admin", async () => {
      const coverImageUrl = await redisRequest("GET", [`cover:${storyId}`]) || null;
      const chapters = await getChaptersFromRedis(storyId);
      const previewChapter = chapters && chapters[0] ? chapters[0].text || chapters[0] : null;
      const token = adminToken(storyId);
      await sendAdminNotificationEmail(storyId, customerEmail, childName, childData, tier, fullBookUrl, coverImageUrl, previewChapter, token);
    });

    // Step 6: Wait for admin approval (same as full flow)
    await step.waitForEvent("upgrade-wait-for-approval", {
      event: "story/approved",
      match: "data.storyId",
      timeout: "15m"
    });

    // Step 7: Send delivery email
    await step.run("upgrade-send-email", async () => {
      const skip = await redisRequest("GET", [`skip-delivery:${storyId}`]);
      if (skip) {
        await redisRequest("DEL", [`skip-delivery:${storyId}`]);
        return;
      }
      const pdfBytes = await fetchImageBytes(pdfBlobUrl);
      const pdfBase64 = pdfBytes.toString('base64');
      await sendDeliveryEmail(customerEmail, childName, pdfBase64, childData, tier, storyId);
    });

    // Step 8: Cleanup
    await step.run("upgrade-cleanup", async () => {
      await deleteChaptersFromRedis(storyId);
      try {
        const imgKeys = await redisRequest("KEYS", [`img:${storyId}:*`]);
        if (imgKeys && imgKeys.length > 0) {
          const urlsToDelete = [];
          for (const k of imgKeys) {
            const url = await redisRequest("GET", [k]);
            const isCover = k === `img:${storyId}:0-0`;
            if (url && !isCover) urlsToDelete.push(url);
            await redisRequest("DEL", [k]);
          }
          if (urlsToDelete.length > 0) await del(urlsToDelete);
        }
      } catch(e) { console.error("Upgrade illustration cleanup error:", e.message); }
      await redisRequest("DEL", [`outline:${storyId}`]);

      await redisRequest("DEL", [`storytoken:${storyId}`]);
      await redisRequest("DEL", [`customeremail:${storyId}`]);
      await redisRequest("DEL", [`childname:${storyId}`]);
      await redisRequest("DEL", [`customdetails:${storyId}`]);
      await redisRequest("DEL", [`guidance:${storyId}`]);
      await redisRequest("DEL", [`facts:${storyId}`]);
      await redisRequest("DEL", [`preview_paid:${storyId}`]);
      try { await del([pdfBlobUrl]); } catch(e) {}
      console.log(`Upgrade cleanup complete for ${storyId}`);
    });

    console.log(`✅ Upgrade complete for ${childName}`);
    return { success: true, childName };
  }
);

// ════════════════════════════════════════════
// STORY GENERATION
// ════════════════════════════════════════════

async function parseCustomDetails(customDetails, heroName) {
  const prompt = `A parent wrote free-text notes for a personalized children's story. Extract every nickname assignment into a precise structured table.

Parent's notes:
"${customDetails}"

Hero's name: ${heroName}

Instructions:
- A "nickname" is any name other than a character's full given name.
- For EACH nickname, identify exactly WHO speaks it and WHO they are addressing.
- Nicknames are ONE-DIRECTIONAL. If A calls B "puppy", that does NOT mean B calls A "puppy". They are different people with different nicknames.
- Include conditional rules (e.g. "he calls her X only when she calls him Y").
- Do NOT invent or infer any nickname not clearly stated in the text.
- If the text says "her nickname is X" it means OTHER characters call her X — not that she uses it herself.

After the NICKNAME TABLE, output a FORBIDDEN USAGE section that explicitly states the reverse of every nickname — i.e. what is NOT allowed.

Output ONLY this structured block, nothing else:

NICKNAME TABLE:
[Speaker] calls [Receiver] → "[nickname]"
(one line per assignment — repeat for each)

CONDITIONAL NICKNAMES (if any):
[Speaker] calls [Receiver] → "[nickname]" — ONLY WHEN [exact condition]

FORBIDDEN USAGE (the reverse of every nickname above — explicitly prohibited):
[Speaker] must NEVER call [Receiver] → "[nickname]" — this nickname belongs to a different speaker
(one line per forbidden reversal)

DIALOGUE ATTRIBUTION CHECKS:
For each nickname, state who may and may not say it in dialogue:
"[nickname]": only [Speaker] may say this. ✗ Wrong if [Receiver] or anyone else says it. Example of a violation: '[Receiver] said, "...[nickname]..."'
(one line per nickname)

DEFAULT: Any character not listed in the NICKNAME TABLE must use the other character's full name only.`;

  try {
    const result = await callClaude(prompt, 600);
    console.log(`Parsed nickname table:\n${result}`);
    return result.trim();
  } catch(e) {
    console.error(`parseCustomDetails failed: ${e.message}`);
    return null;
  }
}

// Deterministic (no LLM) pass: replaces known diminutives with full names unless they're in the approved nickname table.
// This is the final safety net — it cannot be argued around by LLM creativity.
// Strategy: for every full name in the map, check if it appears anywhere in the chapter text.
// If it does, that character is in this story — replace any unapproved diminutive of theirs.
// This does NOT rely on namedCharacters being populated correctly (e.g. siblings in customDetails).
function enforceFullNamesRegex(chapterText, namedCharacters, parsedCustomDetails) {
  if (!chapterText) return chapterText;

  // Extract every approved nickname from the parsed table (lines like: → "Jules")
  const approvedNicknames = new Set();
  if (parsedCustomDetails) {
    for (const m of parsedCustomDetails.matchAll(/→\s*"([^"]+)"/g)) {
      approvedNicknames.add(m[1].trim());
    }
  }

  const diminutiveMap = {
    'Julianna': ['Jules', 'Juli', 'Julie', 'Anna'],
    'Julian': ['Jules', 'Juli'],
    'Benjamin': ['Ben', 'Benny', 'Benji'],
    'Corbin': ['Cor', 'Corby'],
    'Holden': ['Hol', 'Holdy'],
    'Evelyn': ['Evie', 'Eve'],
    'Elizabeth': ['Liz', 'Beth', 'Lizzy', 'Ellie', 'Eliza'],
    'Katherine': ['Kat', 'Kate', 'Kathy', 'Katie'],
    'Alexander': ['Alex', 'Xander'],
    'Samantha': ['Sam', 'Sammie'],
    'Charlotte': ['Charlie', 'Lottie'],
    'Josephine': ['Jo', 'Josie'],
    'Theodore': ['Theo', 'Teddy'],
    'Nathaniel': ['Nate', 'Nat'],
    'William': ['Will', 'Willie', 'Bill'],
    'Nicholas': ['Nick', 'Nicky'],
    'Christopher': ['Chris'],
    'Matthew': ['Matt', 'Matty'],
    'Rebecca': ['Becca', 'Becky'],
  };

  let text = chapterText;
  for (const [fullName, diminutives] of Object.entries(diminutiveMap)) {
    // Only act if this full name actually appears somewhere in the chapter
    if (!text.includes(fullName)) continue;
    for (const dim of diminutives) {
      if (!approvedNicknames.has(dim)) {
        text = text.replace(new RegExp(`\\b${dim}\\b`, 'g'), fullName);
      }
    }
  }
  return text;
}

async function correctNicknames(chapterText, parsedCustomDetails, fullNames = []) {
  if (!parsedCustomDetails || !chapterText) return chapterText;

  // Build a specific watch-list of common English diminutives for each full name
  const diminutiveMap = {
    'Julianna': ['Jules', 'Juli', 'Julie', 'Anna', 'Juli'],
    'Julian': ['Jules', 'Juli'],
    'Benjamin': ['Ben', 'Benny', 'Benji'],
    'Corbin': ['Cor', 'Corby'],
    'Holden': ['Hol', 'Holdy'],
    'Evelyn': ['Evie', 'Eve'],
    'Elizabeth': ['Liz', 'Beth', 'Lizzy', 'Ellie', 'Eliza'],
    'Katherine': ['Kat', 'Kate', 'Kathy', 'Katie'],
    'Alexander': ['Alex', 'Xander'],
    'Samantha': ['Sam', 'Sammie'],
    'Charlotte': ['Charlie', 'Lottie'],
    'Josephine': ['Jo', 'Josie'],
    'Theodore': ['Theo', 'Teddy'],
    'Nathaniel': ['Nate', 'Nat'],
    'William': ['Will', 'Willie', 'Bill'],
    'Nicholas': ['Nick', 'Nicky'],
    'Christopher': ['Chris'],
    'Matthew': ['Matt', 'Matty'],
    'Rebecca': ['Becca', 'Becky'],
  };

  const watchLines = fullNames
    .filter(n => diminutiveMap[n])
    .map(n => `  - "${n}" → watch for and replace: ${diminutiveMap[n].map(d => `"${d}"`).join(', ')}`)
    .join('\n');

  const fullNamesLine = fullNames.length > 0
    ? `\nFULL GIVEN NAMES IN THIS STORY: ${fullNames.join(', ')}\n\nSPECIFIC DIMINUTIVES TO CATCH — these are common English shortenings that must be replaced with the full given name if they appear and are NOT in the NICKNAME TABLE:\n${watchLines || '  (none mapped — still flag any obvious shortening)'}`
    : "";

  const prompt = `You are a copy editor. The chapter text below may contain nickname errors.

AUTHORITATIVE NICKNAME TABLE:
${parsedCustomDetails}${fullNamesLine}

RULES:
1. DIALOGUE ATTRIBUTION: For every line of dialogue containing a nickname, identify the speaker (look for "[Name] said", "said [Name]", "[Name] called", "[Name] whispered", "[Name] replied", etc.). Then check: is that speaker authorized to use that nickname per the NICKNAME TABLE? If not, replace it with the character's full given name.
2. REVERSED USAGE: If the table says A calls B "[nickname]", then B calling A "[nickname]" is always wrong — even if it seems like a playful echo.
3. INVENTED DIMINUTIVES: Check the SPECIFIC DIMINUTIVES list above. If any of those words appear in the text for the named character and are NOT listed in the NICKNAME TABLE as approved, replace them with the full given name.
4. NARRATIVE TEXT: Also check narrator text (e.g. "he called her Jules" is wrong if "Jules" is not in the table).
5. Do not change anything else — plot, dialogue, punctuation, structure must all remain identical.
6. If there are no errors, return the text unchanged.
7. Return the corrected chapter text only. No explanation, no commentary.

CHAPTER TEXT:
${chapterText}`;
  try {
    const corrected = await callClaude(prompt, 3000);
    return corrected.trim();
  } catch(e) {
    console.error(`correctNicknames failed: ${e.message}`);
    return chapterText;
  }
}

// Deterministic pass: removes the most obvious phone/device sentences before the LLM correction runs.
// Targets sentences containing child-device interaction keywords and strips them entirely,
// since rewriting requires context the regex can't safely provide.
function flagPhoneSentences(chapterText) {
  if (!chapterText) return chapterText;
  // Patterns that almost always indicate a child using a phone/device
  const phonePatterns = [
    /[^.!?]*\b(phone|smartphone|tablet|device)\b[^.!?]*(buzz|ding|ping|ring|vibrat|notif|messag|text|snap|post)[^.!?]*[.!?]/gi,
    /[^.!?]*(buzz|ding|ping|vibrat)[^.!?]*\b(phone|device|tablet)\b[^.!?]*[.!?]/gi,
    /[^.!?]*\bmessage from\b[^.!?]*(friend|classmate|\b[A-Z][a-z]+\b)[^.!?]*[.!?]/gi,
    /[^.!?]*\b(texted?|messaged?|DM'?d?)\b[^.!?]*[.!?]/gi,
  ];
  let text = chapterText;
  for (const pattern of phonePatterns) {
    text = text.replace(pattern, '');
  }
  // Clean up any double spaces or blank lines left behind
  return text.replace(/\n{3,}/g, '\n\n').replace(/  +/g, ' ').trim();
}

async function correctPhones(chapterText) {
  if (!chapterText) return chapterText;
  const prompt = `You are a children's book editor. Check the chapter text below for a specific type of error.

RULE: No child in this story may send or receive any digital message from another child — on their own device, on a parent's device, or on any screen. This includes: texts, messages, notifications, group chats, or any digital communication between children. It does not matter whose phone it appears on.

The only permitted child-to-child communication is: talking in person, passing a handwritten note, or a parent making a voice call to another parent.

Violations include (but are not limited to):
- A child's phone buzzing with a message from another child
- A message from a child appearing on a parent's screen or phone
- A child reading a text sent by another child
- Any notification, buzz, or ping connecting one child to another digitally

If you find a violation, rewrite ONLY that passage so the same information is conveyed through an allowed method — e.g. a friend shows up in person, a parent relays a message after a phone call, or a handwritten note is passed. Keep all other plot, dialogue, tone, and structure exactly the same.

If there are no violations, return the text unchanged.
Return the corrected chapter text only. No explanation.

CHAPTER TEXT:
${chapterText}`;
  try {
    const corrected = await callClaude(prompt, 3000);
    return corrected.trim();
  } catch(e) {
    console.error(`correctPhones failed: ${e.message}`);
    return chapterText;
  }
}

async function correctKindness(chapterText, namedCharacters) {
  if (!namedCharacters || namedCharacters.length === 0 || !chapterText) return chapterText;
  const protagonist = namedCharacters[0];
  const friends = namedCharacters.slice(1);
  if (friends.length === 0) return chapterText;
  const friendList = friends.join(', ');
  const prompt = `You are a children's book editor fixing a specific rule violation.

PROTAGONIST: ${protagonist}
PROTECTED FRIENDS (real people in ${protagonist}'s life): ${friendList}

CRITICAL CONTEXT: ${friendList} are ${protagonist}'s real-life friends. They must ONLY appear in this story when they are actively, enthusiastically supporting, helping, or encouraging ${protagonist} in whatever ${protagonist} is trying to do. There is no exception.

THE RULE IN ONE SENTENCE: When a protected friend appears, they must be ON ${protagonist}'s side, doing what ${protagonist} is doing, cheering for what ${protagonist} wants.

VIOLATIONS TO FIX — replace the friend's name with "a classmate" or "another kid" in any sentence where a protected friend:
1. Is involved in conflict, bullying, exclusion, or social cruelty toward anyone
2. Chooses to do something different from what ${protagonist} wants to do (e.g. building a different thing, joining a different team, pursuing a different idea)
3. Expresses doubt, hesitation, or lack of enthusiasm about ${protagonist}'s goal or plan
4. Goes off to do their own thing while ${protagonist} works alone
5. Sides with someone other than ${protagonist} in any disagreement

Fix every sentence in the passage where the violation occurs — not just the first one.

Do not change anything else. If no violations exist, return the text unchanged.
Return corrected chapter text only. No explanation.

CHAPTER TEXT:
${chapterText}`;
  try {
    const corrected = await callClaude(prompt, 3000);
    const result = corrected.trim();
    // Guard: if the model returned an explanation instead of chapter text, discard it.
    // Valid chapter text always starts with "Chapter N:" — anything else is a meta-response leak.
    if (!result.startsWith('Chapter')) {
      console.warn(`correctKindness returned non-chapter text (meta-response leak) — using original`);
      return chapterText;
    }
    // Guard: if the result is dramatically shorter than the original it was probably truncated
    if (result.length < chapterText.length * 0.5) {
      console.warn(`correctKindness result suspiciously short (${result.length} vs ${chapterText.length}) — using original`);
      return chapterText;
    }
    return result;
  } catch(e) {
    console.error(`correctKindness failed: ${e.message}`);
    return chapterText;
  }
}

async function sanitizeOutline(outline, friendNames) {
  if (!friendNames || friendNames.length === 0) return outline;
  const prompt = `You are editing a children's book chapter outline. The following characters are the hero's friends and must NEVER be the source of any conflict, unkindness, or negative behavior in any chapter summary:

PROTECTED FRIENDS: ${friendNames.join(', ')}

Read each chapter summary carefully. Rewrite any summary that has ANY of these problems:
1. A protected friend is doing, saying, or causing anything negative (bullying, mocking, excluding, laughing at someone, being mean)
2. A protected friend is present in the same sentence or clause as an unkind act, in a way that implies they are involved
3. The summary uses "they" or "his friends" to describe unkind behavior while protected friends are in the scene
4. A protected friend chooses to do something different from what the hero wants to do — building a different project, joining a different group, or pursuing their own idea instead of supporting the hero's
5. A protected friend expresses doubt or lack of enthusiasm about the hero's goal, plan, or idea
6. A protected friend is shown going off on their own while the hero does something alone

When rewriting: replace the protected friend with "a classmate" or "another kid". Protected friends may only appear when they are actively helping, encouraging, or joining in with exactly what the hero is doing. Keep the same plot beat.

If a summary has no violation, leave it exactly as written.

Return the complete outline as a valid JSON array. Every object must have exactly these three fields: "title", "summary", "imagePrompt". Do not add, remove, or reorder chapters.

OUTLINE:
${JSON.stringify(outline, null, 2)}`;

  try {
    const raw = await callClaude(prompt, 6000);
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length === outline.length) {
        const changed = parsed.filter((c, i) => c.summary !== outline[i].summary).length;
        console.log(`sanitizeOutline: fixed ${changed} chapter summaries`);
        return parsed;
      }
    }
    console.warn('sanitizeOutline: could not parse result, using original outline');
    return outline;
  } catch(e) {
    console.error(`sanitizeOutline failed: ${e.message}`);
    return outline;
  }
}

async function parseCustomDetails(customDetails) {
  if (!customDetails || !customDetails.trim()) return null;

  const prompt = `You are reading notes a parent wrote about their child for a personalized story. Extract every specific fact stated and list them as a numbered checklist. Be exhaustive — every sentence should produce at least one fact.

Include: names and relationships, ages and grades, school names, physical descriptions, personality traits, what the child is excited or nervous about, specific events or timeline details, friendships, hobbies, family details, and anything else that is a concrete stated fact.

Do NOT infer or extrapolate. Only list things explicitly stated.

Parent's notes:
${customDetails}

Return ONLY a numbered list of facts, one per line. Example format:
1. Benjamin is Julianna's older brother
2. Benjamin is currently in 1st grade
3. Julianna will be starting kindergarten this fall
No headers, no explanation — just the numbered list.`;

  try {
    const raw = await callClaudeHaiku(prompt, 800);
    const facts = raw.trim();
    console.log(`parseCustomDetails: extracted facts:\n${facts}`);
    return facts;
  } catch(e) {
    console.warn(`parseCustomDetails failed (non-fatal): ${e.message}`);
    return null;
  }
}

async function verifyOutlineAgainstFacts(outline, parsedFacts, customDetails) {
  if (!parsedFacts || !customDetails) return outline;

  const prompt = `You are a quality checker for a personalized children's book outline. A parent provided specific facts about their child, and the outline must honor every one of them.

STATED FACTS (extracted from parent's notes):
${parsedFacts}

RAW PARENT NOTES (for reference):
${customDetails}

OUTLINE TO CHECK:
${JSON.stringify(outline, null, 2)}

Your task:
1. Read every fact above
2. Check whether the outline contradicts or ignores any fact
3. Rewrite any chapter summary that contradicts a stated fact, or add a note to the most relevant chapter summary to ensure the fact is included
4. Pay special attention to: grades, school names, relationships, who goes where, what the child already knows or has, timeline details

If a fact is not yet reflected anywhere in the outline, add it to the most relevant chapter's summary.
If the outline is already fully consistent, return it unchanged.

Return ONLY a valid JSON array with the same structure as the input — same number of chapters, each with "title", "summary", and "imagePrompt". No explanation, no markdown.`;

  try {
    const raw = await callClaudeOpus(prompt, 6000);
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length === outline.length) {
        const changed = parsed.filter((c, i) => c.summary !== outline[i].summary).length;
        console.log(`verifyOutline: corrected ${changed} chapter summaries against custom facts`);
        return parsed;
      }
    }
    console.warn('verifyOutline: could not parse result, using original outline');
    return outline;
  } catch(e) {
    console.error(`verifyOutline failed (non-fatal): ${e.message}`);
    return outline;
  }
}

async function generateMilestoneGuidance(milestone, age, name) {
  const ageNum = parseInt(age);
  const ageStage = ageNum <= 6 ? "a 4–6 year old child (pre-K to Grade 1)"
    : ageNum <= 9  ? "a 7–9 year old child (early elementary)"
    : ageNum <= 12 ? "a 10–12 year old child (upper elementary / middle school)"
    : "a 12–14 year old (middle school / early high school)";

  const prompt = `You are a child development specialist and children's book author.

A personalized story is being written for ${name}, age ${age}, about this milestone: "${milestone}"

Generate 4–6 specific, research-informed strategies that genuinely help ${ageStage} navigate this milestone successfully. These will be woven into a children's story as natural narrative moments — not stated as advice.

For each strategy:
- Make it concrete and age-appropriate (something a child this age can actually do or feel)
- Frame it as an experience or realization, not a lesson
- Keep it positive and achievable

Format as a simple numbered list. Each item should be 1–2 sentences. No headers, no explanations, just the strategies.

Example format (for "starting a new school"):
1. Focusing on finding just one friendly face rather than trying to fit in with everyone at once makes the first days feel manageable.
2. Bringing a small familiar object from home can be a quiet comfort during overwhelming moments.
3. Noticing small wins each day — finding the bathroom, remembering a classmate's name — builds confidence faster than waiting for a big breakthrough.`;

  try {
    const raw = await callClaudeOpus(prompt, 600);
    console.log(`Milestone guidance for "${milestone}": ${raw.slice(0, 100)}...`);
    return raw.trim();
  } catch(e) {
    console.error(`generateMilestoneGuidance failed: ${e.message}`);
    return ""; // Fail gracefully — story generates without guidance
  }
}

async function generateOutline(child, tier, storySeed = null, milestoneGuidance = "") {
  const { name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone, customDetails, parsedCustomDetails, parsedFacts } = child;
  const genderPronoun = gender === "girl" ? "she/her" : gender === "boy" ? "he/him" : "they/them";
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const friendLine = friend && friend !== "none" ? `Companion (pet, friend, or sibling): ${friend}.` : "";

  // Build named characters list for outline kindness rule (same logic as chapter batch)
  const namedCharacters = [name];
  if (friend && friend !== "none") {
    friend.split(/,|\band\b/i).forEach(f => {
      const t = f.trim();
      if (t && !namedCharacters.includes(t)) namedCharacters.push(t);
    });
  }
  if (customDetails) {
    const skipWords = new Set(["I","The","A","An","He","She","They","His","Her","Their","When","That","This","If","And","But","So","In","On","At","For","To","Of","My","Our","We","Is","Are","Was","Were","Will","Can","Not","No"]);
    const nameMatches = customDetails.match(/\b[A-Z][a-z]{1,14}\b/g) || [];
    nameMatches.forEach(w => { if (!skipWords.has(w) && !namedCharacters.includes(w)) namedCharacters.push(w); });
  }
  const namedCharactersStr = namedCharacters.join(', ');

  const customBlock = customDetails ? `
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
CRITICAL CUSTOM REQUIREMENTS — READ FIRST
These override all defaults. Follow exactly.
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
${customDetails}
NAMES: Use every character's name exactly as given above. Only use a nickname if the custom details above explicitly state one (e.g. "she calls him Benny"). If no nickname is stated, always write the full name — never shorten, abbreviate, or invent a diminutive.
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
${parsedFacts ? `EVERY FACT BELOW WAS EXTRACTED FROM THE PARENT'S NOTES. EVERY SINGLE ONE MUST BE HONOURED IN THIS OUTLINE:
${parsedFacts}
` : ""}` : "";

  const prompt = `You are a children's book author. Create a ${tier.chapCount}-chapter outline for a personalized ${tier.label}.
${customBlock}
Hero: ${name}, age ${age}, ${genderPronoun}, ${hairDesc} hair, ${eye} eyes
Personality: ${trait}. Loves: ${favorite}. ${friendLine}
Hometown: ${city}, ${region} — use broad geography (landscape, weather, regional feel), never specific street names or addresses.
Milestone/theme: ${milestone}

AGE & SCHOOL GRADE LOGIC — apply this before writing any chapter summaries:
- Derive every character's school grade strictly from their age: age 4–5 = Pre-K/Kindergarten, age 6–7 = Grades 1–2, age 8–9 = Grades 2–3, age 10–11 = Grades 4–5, age 12–13 = Grades 6–7
- Children of different ages are NEVER in the same grade unless they are twins or the custom details explicitly state otherwise
- "Going to school together" means attending the same school building — not the same classroom or grade
- Never invent a grade level for any character that conflicts with their stated age
- If a character is described as younger, they cannot be catching up to or joining the same grade as an older character
- GRADE ADVANCEMENT: If the custom details state current grades AND the story is set in the future (e.g. "next year", "starting school in the fall"), ALL characters advance one grade together. Example: if custom details say "he's in 1st grade, she's in pre-K" and the story is about starting school next year, then he will be in 2nd grade and she will be in Kindergarten — not 1st grade. Every character's grade moves forward by the same number of years. Never freeze one character's grade while advancing another's.

STORY RULES — apply to every chapter summary:
- STICK TO KNOWN DETAILS: Only reference specific real-world details — teacher names, school names, pet names, sibling names, home layout, routines, hobbies, family traditions — if they are explicitly provided in the child's profile or custom details. For anything not specified, keep it general so it cannot clash with the child's real life. Write "his teacher" not an invented name. Write "a place he loved" not an invented location. If it's not in the profile, leave it vague.
- CUSTOM DETAILS ARE BINDING: The custom details provided by the parent are the only source of truth for every fact about these characters' lives — their relationships, where they go, what grade they're in, who they know, what they're doing. Do not infer, extrapolate, or invent any fact that isn't explicitly stated. Do not add sequence, timing, or causality that the custom details don't establish. If the custom details say two siblings are starting school this fall, do not write that one started before the other — that sequence isn't stated, so it doesn't exist. Read the custom details like a contract: every stated fact is fixed, every unstated fact is unknown.
- EXISTING CONNECTIONS ARE FACTS: If the custom details mention that ${name} already knows people at a new school, new place, or new situation — those connections are fixed facts. ${name} is NOT alone. Do not write ${name} as friendless or isolated when the custom details establish that friends, classmates, or known people are already there. The emotional challenge may be nervousness or missing old friends — but never loneliness at a destination where the custom details say people are waiting.
- NAMED CHARACTERS — STRICT RULE: ${namedCharactersStr} may only appear in a chapter summary when they are actively helping, joining in, or enthusiastically encouraging ${name} in exactly what ${name} is trying to do. Named friends must NEVER: be unkind, exclude, or mock anyone; choose to do a different project, activity, or idea from ${name}; express doubt or hesitation about ${name}'s plan; or go off to do their own thing while ${name} works alone. Any scene involving conflict, social difficulty, or diverging choices must use only ${name} and completely unnamed characters ("a classmate", "some kids"). Named characters exist to be on ${name}'s team — always.
- NO PHONES OR DEVICES: This story world has no smartphones, cell phones, tablets, or personal devices — for anyone, children or adults. Nobody sends or receives texts, messages, or notifications. If characters need to communicate, they talk in person or pass a handwritten note.
- NO ASSUMED DISABILITIES: Do not give any named character a wheelchair, mobility aid, prosthetic limb, visual impairment, hearing aid, or any other physical disability or adaptive device unless it is explicitly stated in the child's profile or custom details. This applies to ${name} and all named friends.

CONFLICT SOURCE — this is critical: All tension and difficulty comes from the milestone challenge itself — self-doubt, the difficulty of the task, bad luck, time pressure. Named friends never appear in conflict scenes. All conflict involves only ${name} and unnamed characters.

${milestoneGuidance ? `MILESTONE GUIDANCE — weave these approaches naturally into the story arc. ${name} should discover and practice these strategies through experience, not be told about them. They should feel like story moments, not lessons:
${milestoneGuidance}
` : ""}${storySeed ? `STORY ARC DIRECTION — the customer already read a preview based on this arc. Your outline MUST follow this same general direction so the full story matches what they were shown:
${storySeed}

` : ""}EMOTIONAL TONE — CRITICAL:
${parseInt(age) <= 7
  ? `${name} is ${age} years old. This book will be read TO or BY ${name}. Its job is to make them feel safe, brave, and understood — not heavy, sad, or overwhelmed.
EMOTIONAL CEILING: The deepest negative feeling allowed in any chapter summary is a small flutter of nerves or a brief moment of uncertainty. That is the maximum. No chapter may dwell in sadness, loneliness, or doubt — any hard feeling must be brief and immediately followed by comfort, a small win, or forward movement in the same chapter.
CHAPTER TITLES: Titles must NEVER name a negative emotional state. Banned words and concepts: Lonely, Loneliness, Alone, Sad, Sadness, Doubt, Fear, Scared, Lost, Hard, Dark, Worry, Trouble, Awful, Terrible, Worst. Titles must be warm, curious, or slightly mysterious — they hint at the adventure, not the ache. "A Fluttery Kind of Morning" yes. "Lunchtime Loneliness" never.
THE CLIMAX IS STILL A CLIMAX — but for this age, the darkest moment is a gentle setback or a moment of "I'm not sure I can" — not devastation, not isolation, not tears that go uncomforted. The breakthrough comes quickly and warmly.`
  : parseInt(age) <= 9
  ? `${name} is ${age} years old. Emotions can be real — disappointment, worry, frustration — but they must be clearly passing. Any setback must be followed by visible progress or comfort within the same chapter. Sustained sadness must not carry across more than one chapter. Chapter titles should be evocative, not bleak. The overall emotional current of the book is warm and hopeful.`
  : `${name} is ${age} years old. Genuine emotional complexity is appropriate — the story can sit with difficulty and let characters feel real, layered emotions across the arc.`}

This is a ${tier.chapCount}-chapter ${tier.label} (~${(tier.chapCount * tier.wordsPerChap).toLocaleString()} words total). Use this narrative structure — these are not suggestions, they are the blueprint:

NARRATIVE BLUEPRINT:
1. HOOK IMMEDIATELY: Chapter 1 opens mid-action or mid-problem. No warming up. Something is already happening. Within the first chapter, establish clearly what ${name} WANTS — something specific and small (not just "to be brave" — but "to make one friend to eat lunch with" or "to get through the first day without crying"). This specific desire drives the whole story.
2. ESCALATING ATTEMPTS: In the rising action, ${name} tries to get what they want. Each attempt either fails outright or partially works but creates a new complication. Things get harder, not easier. The middle of the story is where the stakes rise — not where they plateau.
3. TURNING POINT: One chapter is the moment of choice. ${name} must decide: try again or give up. Be brave or stay safe. This is the heart of the story — the moment the reader leans forward. ${parseInt(age) <= 7 ? "For this age, keep it gentle: a moment of 'I don't think I can' that becomes 'I'll try one more time.'" : "Make the choice feel genuinely hard — the wrong option should be tempting."}
4. CHARACTER-DRIVEN RESOLUTION: ${name} solves the problem through their OWN action and choice — not luck, not an adult fixing it, not a magical coincidence. The breakthrough comes because ${name} did something. The reader should feel ${name} earned it.
5. CLOSING ECHO: The final chapter circles back to something from the opening — a image, a feeling, a setting, a specific detail — but now it feels different because ${name} has changed. The reader feels the distance travelled.

Arc structure across ${tier.chapCount} chapters:
- Opening (first 20%): Hook → introduce ${name}'s world → establish the specific WANT and the obstacle
- Rising action (middle 50%): Attempts fail or complicate → stakes rise → ${name} doubts themselves
- Turning point (next 20%): ${parseInt(age) <= 7 ? "Gentle setback → moment of 'I'm not sure I can' → decision to try one more time" : "Highest stakes → hardest choice → breakthrough moment"}
- Resolution (final 10%): ${name}'s own action resolves the problem → closing image echoes the opening, but changed

You MUST return EXACTLY ${tier.chapCount} chapters — no more, no fewer.

Return ONLY a valid JSON array of EXACTLY ${tier.chapCount} objects. Each object must have:
- "title": chapter title WITHOUT chapter number (4-6 words, evocative e.g. "The Day Everything Changed")
- "summary": 2-3 sentence summary of what happens
- "imagePrompt": a 1-sentence description of the key visual moment in this chapter (for illustration) — describe only cheerful, positive, bright, well-lit moments (e.g. exploring outdoors, building something, celebrating, helping a friend). Always daytime or warmly lit indoor scenes. No nighttime scenes, dark rooms, moonlit windows, or dim lighting. No danger, peril, conflict, or emotionally intense scenes.

No markdown, no explanation, just the JSON array.`;

  const raw = await callClaudeOpus(prompt, 6000);
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
  const { name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone, customDetails } = child;
  const genderPronoun = gender === "girl" ? "she/her" : gender === "boy" ? "he/him" : "they/them";
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const friendLine = friend && friend !== "none" ? `Companion (pet, friend, or sibling): ${friend}.` : "";
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

  const prompt = `Write Chapter ${index + 1} of a personalized children's ${tier.label}. Target length: ${tier.wordsPerChap} words. Write the full chapter — do not stop early.

Chapter title: "${chap.title}"
What happens in THIS chapter: ${chap.summary}
${recentContext}

Full story arc (for consistency — do NOT jump ahead):
${arcContext}

Hero: ${name}, age ${age}, ${genderPronoun}, ${hairDesc} hair, ${eye} eyes
Personality: ${trait}. Loves: ${favorite}. ${friendLine}
Setting: ${city}, ${region} — use the city name and regional geography naturally, but never specific street names, addresses, or neighbourhood names.
Central theme: ${milestone}
${isFirst ? "\nThis is the opening chapter — establish the world vividly, introduce the hero with warmth and charm." : ""}
${isLast ? "\nThis is the final chapter — resolve the milestone beautifully, end with warmth and hope." : ""}

Writing style: ${parseInt(age) <= 5 ? "Warm, lyrical, read-aloud sentences. Short paragraphs. Rich sensory detail." : parseInt(age) <= 9 ? "Engaging, age-appropriate vocabulary. Mix of action, humor, and emotion." : "Rich vocabulary, complex emotions, vivid scenes. Feels like a real middle-grade novel."}
Emotional ceiling: ${parseInt(age) <= 7 ? `${name} is ${age} years old. The maximum negative emotion in any passage is a small flutter of nerves or a brief moment of worry — that is the ceiling. Any sad or worried feeling must be quickly met with comfort or a positive shift within the same scene. ${name} may feel a little unsure but NEVER devastated, crushed, or deeply lonely. The chapter's emotional texture must be warm and cozy, even during the hard parts.` : parseInt(age) <= 9 ? `Emotions can be real but must be clearly passing. Hard feelings resolve within the chapter. Overall tone stays warm and hopeful.` : `Full emotional complexity appropriate for this age.`}

CRITICAL: This chapter must follow directly from what came before and lead naturally into the next. Stay true to the established characters, setting, and tone. Do not introduce unrelated premises.
CHARACTERS: Every person mentioned — siblings, friends, pets, parents — must be portrayed warmly and positively. No eye-rolling, dismissiveness, mockery, or negativity from any character toward another.
NAMED FRIENDS IN CHAPTERS: If any of ${namedCharactersStr} appear, they must be actively on ${name}'s side — joining in, helping, or cheering for exactly what ${name} is doing. They must NEVER choose a different project or activity, express doubt about ${name}'s plan, or go off to do their own thing. Any character who diverges from ${name}'s goal must be given an unnamed label ("a classmate", "another kid") — never a protected name.

FORMAT:
- First line MUST be exactly: "Chapter ${index + 1}: ${chap.title}"
- Then a blank line
- Then the full story text
- Nothing else`;

  return await callClaudeOpus(prompt, tier.maxTokensPerChap + 200);
}

// ════════════════════════════════════════════
// BATCH CHAPTER GENERATION
// ════════════════════════════════════════════

async function generateChapterBatch(child, outline, startIdx, endIdx, priorChapters, tier, milestoneGuidance = "") {
  const { name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone, customDetails, parsedCustomDetails, parsedFacts } = child;
  const genderPronoun = gender === "girl" ? "she/her" : gender === "boy" ? "he/him" : "they/them";
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const friendLine = friend && friend !== "none" ? `Companion: ${friend}.` : "";

  // Build a list of all named characters from the order (hero + ALL friends + custom details names)
  const namedCharacters = [name];
  if (friend && friend !== "none") {
    friend.split(/,|\band\b/i).forEach(f => {
      const t = f.trim();
      if (t && !namedCharacters.includes(t)) namedCharacters.push(t);
    });
  }
  if (customDetails) {
    // Extract capitalised words that look like names (2+ capital-first words, not common words)
    const skipWords = new Set(["I","The","A","An","He","She","They","His","Her","Their","When","That","This","If","And","But","So","In","On","At","For","To","Of","My","Our","We","Is","Are","Was","Were","Will","Can","Not","No"]);
    const nameMatches = customDetails.match(/\b[A-Z][a-z]{1,14}\b/g) || [];
    nameMatches.forEach(w => { if (!skipWords.has(w) && !namedCharacters.includes(w)) namedCharacters.push(w); });
  }
  const namedCharactersStr = namedCharacters.join(', ');

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

  const customBlock = customDetails ? `
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
CRITICAL CUSTOM REQUIREMENTS — READ FIRST
These override all defaults. Follow exactly.
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
${customDetails}
NAMES: Use every character's name exactly as given above. Only use a nickname if the custom details above explicitly state one (e.g. "she calls him Benny"). If no nickname is stated, always write the full name — never shorten, abbreviate, or invent a diminutive.
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
${parsedFacts ? `CONFIRMED FACTS — every item below is a stated fact from the parent's notes. Every single one must appear correctly in the chapters you write:
${parsedFacts}
` : ""}` : "";

  const customReminder = customDetails ? `
FINAL CHECK before you finish:
1. Every character's name is written exactly as given — no shortenings or invented diminutives unless the custom details above explicitly state a nickname.
2. Any ages or grades mentioned for secondary characters are factually consistent — a younger child cannot be in the same grade as an older child.
3. "Going to school together" means the same school building, not the same classroom or grade.
Correct any errors before outputting.` : "";

  const prompt = `You are writing chapters ${startIdx + 1}–${endIdx} of a personalized children's ${tier.label}.
${customBlock}
HERO: ${name}, age ${age}, ${genderPronoun}, ${hairDesc} hair, ${eye} eyes
Personality: ${trait}. Loves: ${favorite}. ${friendLine}
Setting: ${city}, ${region} — use the city name and regional geography (mountains, rivers, weather, landscape) naturally, but NEVER use specific street names, addresses, or neighbourhood names.
${arcContext}
${priorText}

NOW WRITE these ${endIdx - startIdx} chapters in order:
${batchOutline}

${milestoneGuidance ? `MILESTONE APPROACH — these are the real strategies that help children navigate this milestone. Weave them into the story naturally through what ${name} experiences, tries, feels, and discovers. Never state them as advice or lessons — show them happening:
${milestoneGuidance}
` : ""}RULES:
- Write all ${endIdx - startIdx} chapters back to back
- Each chapter: exactly ${tier.wordsPerChap} words
- Each chapter starts with "Chapter N: Title" on its own line, then a blank line, then the story
- Maintain the exact same characters, setting, and tone throughout
- Each chapter flows naturally from the last — no new unrelated premises
- CONFLICT SOURCE: All tension comes from the milestone challenge — self-doubt, difficulty, bad luck, external obstacles. Named friends (${namedCharactersStr}) are always supportive. If the chapter outline refers to "a classmate" or "another kid" doing something unkind, write that character as a physically distinct stranger — never give them the name or identity of a named friend, and never place a named friend in the same action. If ${namedCharactersStr.split(', ').join(' or ')} is present in a scene where unkindness occurs, they must be bystanders who react with concern — never the one doing the unkind thing
- SCENE LOGIC: Every scene must make physical sense. Characters must be in locations that make sense for the time of day and story context. If a character wakes up, they wake up in their bed. If they are at school, they arrived there. Never have a character inexplicably appear somewhere without getting there first. Within a single paragraph, a character's location must be internally consistent — if they are inside, every detail in that paragraph must reflect being inside; if they are outside, every detail must reflect being outside. Never write a sentence where a character is simultaneously inside (e.g. looking through a window) and outside (e.g. "staying outside") in the same breath.
- NO DANGLING SETUPS: If a sentence creates suspense or anticipation — "he heard something that made his stomach drop", "then she saw it", "something was wrong" — the very next sentence must deliver what that something is. Never use a suspense hook as a transition into unrelated backstory. The payoff must be immediate and in the same scene.
- NO ASSUMED DISABILITIES: Do not give any named character a wheelchair, mobility aid, prosthetic limb, visual impairment, hearing aid, or any other physical disability or adaptive device unless it is explicitly stated in the child's profile or custom details. This applies to ${name} and all named friends (${namedCharactersStr}).
- DIALOGUE COHERENCE: Every line of dialogue must logically follow from the line before it. A reply must make sense as a direct response to what was just said. If a character says two things in one turn — a greeting AND a question, or a nickname AND a statement — the reply must address both, not just one. Never respond only to a nickname trigger and ignore the actual question or statement that followed it. If a family member (sibling, parent) speaks directly to ${name}, ${name} must respond to what they said — never skip past it as if it were unheard.
- AGE & GRADE LOGIC: Derive school grades strictly from age (age 5 = Kindergarten, age 6–7 = Grade 1–2, etc.). Children of different ages are never in the same grade unless they are twins or custom details say otherwise. "Going to school together" = same school building, not same grade. Never write that a younger child is joining or catching up to an older child's grade. GRADE ADVANCEMENT: If the custom details state current grades and the story is set in the future, ALL characters advance one grade together — if he's in 1st grade now and the story takes place next year, he is in 2nd grade. Never freeze one character's grade while advancing another's.
- PROTAGONIST'S SCHOOL NAME: If a specific school name is provided for ${name} in the profile or custom details, use that exact name every single time the school is mentioned. Never substitute a different school name, never invent an alternative. If the custom details say ${name} is going to "Foothill Elementary", then every reference to ${name}'s school must say "Foothill Elementary" — not "Sunshine Elementary", not "Maple Grove", not any invented name. The protagonist's school name is a fixed fact, not a creative choice.
- EXISTING CONNECTIONS ARE FACTS: If the custom details state that ${name} already knows people at a new school, new team, new place, or new situation — those people are real and present. ${name} is NOT alone or friendless at that destination. Never write ${name} as having no one when the custom details establish that specific people are already there. The emotional challenge may be nervousness or missing old friends — but the known connections must appear in the story as real, warm presences.
- Writing style: ${parseInt(age) <= 5 ? "Warm, lyrical, read-aloud. Short paragraphs. Sensory detail." : parseInt(age) <= 9 ? "Engaging, age-appropriate. Mix of action, humor, emotion." : "Rich vocabulary, complex emotions. Feels like a real middle-grade novel."}
- EMOTIONAL CEILING: ${parseInt(age) <= 7 ? `${name} is ${age} years old. This book will be read TO or BY ${name} — it must make them feel safe and brave, not heavy or sad. The maximum allowed negative emotion in any single passage is a small flutter of nerves, a tiny twinge of worry, or a brief moment of "I hope this works." That is the ceiling. Any sad or worried feeling must be met with immediate comfort, warmth, or a shift toward something positive — within the SAME scene, never left hanging. ${name} may feel a little nervous, a little unsure — but NEVER devastated, crushed, deeply lonely, or overwhelmed by sadness. No passage should make the real child reading this feel worse about their own situation. A moment of sadness is okay; a chapter that marinates in sadness is not. The emotional texture of every chapter must be: cozy, warm, and brave — even during the hard parts.` : parseInt(age) <= 9 ? `Emotions can be real — disappointment, worry, brief sadness — but they must be clearly passing. Any hard emotional moment must be followed within the same chapter by comfort, progress, or a positive turn. Do not let ${name} sit in sadness, self-doubt, or loneliness for extended passages. The overall emotional texture must remain warm and hopeful.` : `${name}'s emotional life can have genuine complexity and depth appropriate for this age.`}
- CHAPTER PURPOSE: Every chapter must earn its place. Before writing, answer: why does this chapter exist? It must introduce a new problem, a new attempt, new information, or a new emotional shift. A chapter that merely passes time is not acceptable.
- CHAPTER STRUCTURE: Every chapter has a beginning, middle, and end — even if subtle. Start: something is happening or about to happen. Middle: a complication or development that raises the stakes or deepens the situation. End: a change, a reveal, or a new tension. The reader must feel the chapter move.
- OPENINGS: Drop the reader directly into action, dialogue, or a vivid moment. Never open a chapter with backstory, weather description, or a character waking up and thinking about the day. The first sentence must create immediate forward motion — something is already in motion when we arrive.
- CHANGE IS MANDATORY: If nothing changes by the end of a chapter, rewrite it. Change can be external (a plot event, a new obstacle, something gained or lost) or internal (a feeling shifts, a realization lands, a decision is made). Both count. Neither can be skipped.
- ESCALATION: When ${name} tries something and it doesn't work, the next attempt must be harder, not easier. Things should get more complicated before they get better. A story where the first try works, then the second try works, then the third try works is not a story — it's a list. Make the middle hard.
- CHARACTER EARNS THE WIN: The resolution of the problem must come from ${name}'s own decision or action. An adult stepping in and fixing it, a lucky accident, or a coincidence that saves the day is a cheat. The reader must feel that ${name} caused the breakthrough — because they chose to try again, because they were kind when it was hard, because they did the thing they were afraid to do.
- WANT IS THE ENGINE: Keep ${name}'s specific want visible throughout. The reader should always know what ${name} is trying to get or do. When that want is finally met (or meaningfully transformed), the story is over. If the want disappears from the middle chapters, the story loses its engine.
- EMOTIONAL TRUTH OVER LESSON: Never state the theme, the moral, or what ${name} learned. Show it through what ${name} does at the turning point. A child reading should feel the meaning — not be told it.
- CHAPTER TITLES: Titles should be evocative and slightly mysterious — they should hint at the chapter's emotional core without giving it away. Avoid flat descriptive titles like "The Competition" or "A Hard Day." Prefer titles with personality: a fragment of dialogue, a surprising image, an unexpected phrase that makes the reader curious.
- ENDINGS — FORWARD PULL: Every chapter ending must pull the reader forward. The hook doesn't need to be dramatic — it can be a question, a surprise, a worry, or a quiet promise of what's coming. What it cannot be is a full stop. The last sentence leans forward. Never wrap the scene up neatly; leave one thread loose.
- MOMENTUM: Chapters are pacing tools. Some chapters build "just one more…" energy — fast, propulsive, ending on a cliffhanger. Others give the reader a breath — slower, emotional, landing on feeling rather than action. Vary the rhythm deliberately. A string of identical chapter shapes kills momentum.
${parseInt(age) >= 8 ? `- SENTENCE RHYTHM: Match sentence length to emotional tempo. Action scenes: short, punchy, immediate. Emotional scenes: longer sentences, more detail, more pause. The reader should feel the difference physically — fast chapters read fast, slow chapters breathe.` : ""}
${parseInt(age) >= 10 ? `- CHARACTER DEPTH: Layer ${name}'s internal life across chapters. Track how their thinking shifts — what they believed at the start that turns out to be wrong, what they're beginning to understand, what they're still not ready to face. Let subtext carry weight: what a character doesn't say, doesn't do, or notices but ignores reveals more than exposition. The chapter becomes a narrative lever — it shapes meaning, not just movement.` : ""}
${isLastBatch ? "- The final chapter must resolve the milestone beautifully with warmth and hope. End on a warm, satisfying, conclusive note — no cliffhanger on the last chapter." : ""}
- SAFETY: This is a children's book. Never include swear words, sexual content, or graphic violence. All stories must resolve with hope and warmth.
- STICK TO KNOWN DETAILS: Only use specific real-world details — teacher names, school names, pet names, sibling names, home layout, daily routines, specific hobbies, family traditions — if they are explicitly provided in the child's profile or custom details above. For anything not specified, use general language instead of inventing specifics. Say "his teacher" not "Ms. Johnson". Say "their house" not invented room names. Say "a book she loved" not a specific title. If a detail is not in the profile, keep it vague so it cannot clash with the child's real life.
- CUSTOM DETAILS ARE BINDING: The custom details are the only source of truth for every fact about these characters' lives. Do not infer, extrapolate, or invent anything not explicitly stated. Do not add sequence, timing, or causal relationships that the custom details don't establish. If a fact about a character's situation, history, or timeline isn't written in the custom details, it is unknown — do not fill in the blank. Read the custom details like a legal contract: stated facts are fixed, unstated facts do not exist.
- FREQUENCY IS EXACT AND NON-TRANSFERABLE: Frequency words are literal and binding. If custom details say something happened "once" or "one time", it happened exactly once — never imply it is recurring, regular, or habitual. If two separate facts share a setting (e.g. "helps with drop-off daily" AND "had lunch in the cafeteria once"), do not merge them into a single recurring event. Each fact stands alone with its own frequency. Never promote a one-time event into a habit. Never borrow the frequency of one fact and attach it to another.
- NAMED CHARACTERS IN POSITIVE SCENES ONLY: ${namedCharactersStr} may only appear in scenes where they are actively helping, encouraging, or sharing a warm moment with ${name}. They must NEVER appear in any scene involving conflict, difficulty, unkindness, or social tension — not as the cause, not as bystanders, not as observers. When writing any scene that involves struggle, exclusion, or unkind behavior, write as if the named characters do not exist. Use only ${name} and completely unnamed characters ("a classmate", "some kids", "another child") for conflict scenes. The named characters exist in this story only to be supportive — they are not plot devices for conflict.
- NO PHONES OR DEVICES: This story world has no smartphones, cell phones, tablets, or personal devices — for anyone, children or adults. Nobody sends or receives texts, messages, or notifications. If characters need to communicate, they talk in person or pass a handwritten note.
${customReminder}
Write all ${endIdx - startIdx} chapters now. Nothing else.`;

  const raw = await callClaudeOpus(prompt, tier.maxTokensPerChap * (endIdx - startIdx) + 500);

  // Split the response into individual chapters
  const chapTexts = raw.split(/(?=Chapter \d+:)/g).filter(c => c.trim());

  // If batch came back short, retry each missing chapter individually — never pad with placeholder text
  while (chapTexts.length < endIdx - startIdx) {
    const missingNum = startIdx + chapTexts.length + 1;
    const missingOutline = outline[startIdx + chapTexts.length];
    console.warn(`Batch returned only ${chapTexts.length}/${endIdx - startIdx} chapters — retrying chapter ${missingNum} individually`);

    try {
      const retryPrompt = `Write Chapter ${missingNum} of a personalized children's ${tier.label}.

Chapter title: "${missingOutline?.title}"
Chapter summary: ${missingOutline?.summary}

Write approximately ${tier.wordsPerChap} words. Format your response exactly like this:
Chapter ${missingNum}: ${missingOutline?.title}

[chapter text here]

Nothing else before or after the chapter.`;

      const retryRaw = await callClaudeOpus(retryPrompt, tier.maxTokensPerChap + 300);
      const retryText = retryRaw.trim();
      // Ensure it starts with the chapter header
      if (retryText.startsWith('Chapter')) {
        chapTexts.push(retryText);
      } else {
        chapTexts.push(`Chapter ${missingNum}: ${missingOutline?.title || 'The Next Adventure'}\n\n${retryText}`);
      }
    } catch(e) {
      console.error(`Individual retry for chapter ${missingNum} failed: ${e.message}`);
      // Only use placeholder as absolute last resort after retry failure
      chapTexts.push(`Chapter ${missingNum}: ${missingOutline?.title || 'The Next Adventure'}\n\n[Chapter generation failed — please regenerate this story.]`);
    }
  }

  return chapTexts.slice(0, endIdx - startIdx);
}

async function generateIllustrations(child, outline, chapters, tier) {
  const { name, age, hair, hairLength, hairStyle, eye, city, region } = child;
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const charDesc = `a young child with ${hairDesc} hair and ${eye} eyes`;

  const styleGuide = getStyleGuideForAge(age);

  const illustrations = {}; // keyed by "chapterIndex-imageIndex"

  for (let ci = 0; ci < outline.length; ci++) {
    const chap = outline[ci];
    for (let ii = 0; ii < tier.imagesPerChap; ii++) {
      const key = `${ci}-${ii}`;
      const scenePrompt = ii === 0
        ? chap.imagePrompt
        : `Another moment from this scene: ${chap.summary}`;

      const prompt = `${styleGuide}. Scene: ${scenePrompt} The main character is ${charDesc}. Setting: ${city}, ${region}. No text in the image.`;

      try {
        console.log(`Generating image ${key}`);
        const imageUrl = await callDallE(prompt);
        const imageBytes = await fetchImageBytes(imageUrl);
        illustrations[key] = imageBytes.toString('base64');
        console.log(`Image ${key} done`);
      } catch(err) {
        console.error(`Image ${key} FAILED:`, err.message);
      }
    }
  }

  return illustrations;
}

async function extractScenePrompt(chapterText, name, age, city, region) {
  // Strip chapter title line, keep body text only
  const lines = chapterText.split(/\n+/).filter(l => l.trim());
  const body = lines.slice(1).join(' ').slice(0, 1500); // Cap at ~1500 chars to keep the call cheap

  const ageNum = parseInt(age);

  // Age-specific instructions for what kind of scene to find and how to describe it
  const ageGuidance = ageNum <= 7
    ? `This is for a very young reader (age ${age}). Pick the most literal, action-clear moment — the one where it's most obvious what ${name} is physically doing. Big emotions and clear body language matter most. The illustration must carry part of the story on its own. Describe exactly what is happening: the action, the expression on ${name}'s face, who else is there, and where they are.`
    : ageNum <= 10
    ? `This is for a middle-reader (age ${age}). Pick a moment that allows for visual humor, personality, or something the text hints at but doesn't fully describe — a hidden joke, an exaggerated reaction, a telling detail. The illustration should enhance the story, not just repeat it. Describe the scene and include one detail that adds something extra — something funny, surprising, or revealing about ${name}'s character.`
    : `This is for an older reader (age ${age}). Pick the most emotionally significant or atmospheric moment in the chapter — a scene that captures the mood, the stakes, or the world of the story. The illustration should feel cinematic. Describe the scene focusing on setting, atmosphere, and ${name}'s emotional state as shown through their posture and expression.`;

  const prompt = `You are selecting the single best moment from a children's story chapter to illustrate.

${ageGuidance}

Rules:
- The moment must be positive, warm, or exciting — no conflict, sadness, or peril
- Must be well-lit and daytime (or warmly lit indoors)
- Must feature ${name} doing something specific and concrete

Return ONLY a single sentence describing exactly what to draw. Be specific: name the action, the location, any other characters present, and one expressive detail. Do not mention lighting style or illustration style. Start with "${name}".

Good example (ages 5–7): "${name} beams with pride, arms stretched wide, as a huge tower of colorful blocks stands tall in the living room."
Good example (ages 7–10): "${name} tries to look calm while their little sibling accidentally sits on the project they worked so hard on, squashing it flat."
Good example (ages 9–12): "${name} stands alone at the edge of a crowded schoolyard, backpack clutched tight, watching the other kids from a distance — but with the smallest hint of a determined smile."

CHAPTER EXCERPT:
${body}`;

  try {
    const result = await callClaude(prompt, 200);
    const scene = result.trim().replace(/^["']|["']$/g, '');
    console.log(`Scene extracted (age ${age}) for illustration: ${scene}`);
    return scene;
  } catch(e) {
    console.warn(`extractScenePrompt failed — using fallback: ${e.message}`);
    return `${name} on an adventure in ${city}`;
  }
}

async function callFalInstantCharacterOnce(referenceImageUrl, scenePrompt) {
  const FAL_KEY = process.env.FAL_KEY;
  if (!FAL_KEY) throw new Error("FAL_KEY environment variable is not set");

  // Submit to fal.ai queue
  const submitRes = await fetch('https://queue.fal.run/fal-ai/instant-character', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      image_url: referenceImageUrl,
      prompt: scenePrompt,
      size: 'square_hd',
      scale: 0.8   // slightly below max so background has room to breathe
    }),
    signal: AbortSignal.timeout(30000)
  });

  if (!submitRes.ok) {
    const err = await submitRes.text();
    throw new Error(`fal.ai submit error ${submitRes.status}: ${err.slice(0, 200)}`);
  }

  const { request_id } = await submitRes.json();
  if (!request_id) throw new Error("fal.ai: no request_id in submit response");
  console.log(`fal.ai instant-character submitted: ${request_id}`);

  // Poll for completion (up to 6 minutes, every 6 seconds)
  const statusUrl = `https://queue.fal.run/fal-ai/instant-character/requests/${request_id}/status`;
  const resultUrl = `https://queue.fal.run/fal-ai/instant-character/requests/${request_id}`;
  const deadline = Date.now() + 360000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 6000));
    const statusRes = await fetch(statusUrl, {
      headers: { 'Authorization': `Key ${FAL_KEY}` }
    });
    const status = await statusRes.json();
    console.log(`fal.ai status: ${status.status}`);

    if (status.status === 'COMPLETED') {
      const resultRes = await fetch(resultUrl, {
        headers: { 'Authorization': `Key ${FAL_KEY}` }
      });
      const result = await resultRes.json();
      const imageUrl = result?.images?.[0]?.url;
      if (!imageUrl) throw new Error("fal.ai: no image URL in result");
      console.log(`fal.ai instant-character done: ${imageUrl.slice(0, 60)}`);
      const imageBytes = await fetchImageBytes(imageUrl);
      // A real square_hd illustration should be well over 50KB — anything smaller is likely
      // a black/failed image returned silently by fal.ai (content rejection or model error)
      if (imageBytes.length < 20000) {
        throw new Error(`fal.ai returned a suspiciously small image (${imageBytes.length} bytes) — likely a black or failed image`);
      }
      return imageBytes;
    }

    if (status.status === 'FAILED') {
      throw new Error(`fal.ai generation failed: ${JSON.stringify(status.error || status).slice(0, 200)}`);
    }
  }

  throw new Error("fal.ai instant-character timed out after 6 minutes");
}

async function callFalInstantCharacter(referenceImageUrl, scenePrompt) {
  try {
    return await callFalInstantCharacterOnce(referenceImageUrl, scenePrompt);
  } catch(e) {
    if (e.message.includes("timed out")) {
      console.warn("fal.ai timed out on first attempt — resubmitting to queue");
      return await callFalInstantCharacterOnce(referenceImageUrl, scenePrompt);
    }
    if (e.message.includes("suspiciously small") || e.message.includes("black or failed")) {
      // Retry with a stripped-down prompt — complex prompts occasionally trigger silent rejection
      const fallbackPrompt = scenePrompt.split('.').slice(0, 3).join('.') + '. Cheerful, bright daytime scene. Bold outlined digital illustration with rich painted colors.';
      console.warn(`fal.ai returned black image — retrying with simplified prompt: ${fallbackPrompt.slice(0, 120)}`);
      return await callFalInstantCharacterOnce(referenceImageUrl, fallbackPrompt);
    }
    throw e;
  }
}

function callDallE(prompt, size = "1024x1024") {
  const payload = JSON.stringify({
    model: "dall-e-3",
    prompt,
    n: 1,
    size,
    quality: "standard"
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.openai.com",
      port: 443,
      path: "/v1/images/generations",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
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
          resolve(data.data[0].url);
        } catch(e) {
          reject(new Error("DALL-E parse error: " + body.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("DALL-E timeout")));
    req.write(payload);
    req.end();
  });
}

// Calls GPT-4o vision to extract a precise character description from the cover image
async function designCharacters(childData, outline) {
  const { name, age, gender, hair, hairLength, hairStyle, eye, friend, customDetails } = childData;
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const genderDesc = gender === "girl" ? "girl" : gender === "boy" ? "boy" : "child";
  const friendLine = friend && friend !== "none" ? `\nCompanion/pet: ${friend}.` : "";

  const imagePrompts = outline.map((c, i) => `Ch${i + 1}: ${c.imagePrompt}`).join('\n');

  const customBlock = customDetails ? `\nCustom details provided by the parent (contains exact physical descriptions for secondary characters — use these as ground truth):\n${customDetails}\n` : "";

  const prompt = `You are designing characters for a children's illustrated book. Your job is to assign consistent physical descriptions to all recurring characters so an illustrator can draw them the same way every time.

Known main character: ${name}, ${age}-year-old ${genderDesc}, ${hairDesc} hair, ${eye} eyes.${friendLine}
${customBlock}
Chapter scene descriptions (used to identify all characters):
${imagePrompts}

Task:
1. Identify every distinct character who appears in 2 or more chapter scenes (siblings, friends, antagonists, pets, teachers, etc.)
2. For each recurring character, write a specific, consistent physical description (hair color, hair length, hair texture, eyes, skin, clothing style, distinguishing features). CRITICAL: If the custom details above describe a character's appearance, use those details exactly — do not invent different ones. If the custom details say a character has shoulder-length straight hair, write that. If they say a character is a boy or uses he/him, mark them as male.
3. Also write the definitive description for ${name} using their known details

Return ONLY a valid JSON object. Keys are character names, values are 1-2 sentence physical descriptions. Each description MUST include: the character's exact age as "X-year-old" (this is mandatory — an illustrator will use this to determine body size and face maturity), gender, hair (color, length, texture), eye color, and a clothing style hint. Example:
{
  "${name}": "a ${age}-year-old ${genderDesc} with ${hairDesc} hair and ${eye} eyes, wearing a teal pinafore dress and white shirt",
  "Jake": "a stocky 9-year-old boy with short red hair, pale freckled skin, and a green t-shirt",
  "Mom": "a tall adult woman with shoulder-length dark hair, warm brown eyes, and a floral blouse",
  "Biscuit": "a fluffy golden retriever with floppy ears and a red collar"
}

CRITICAL RULES:
- Every human character description must start with their exact age ("a 7-year-old boy", "an adult woman", "a 35-year-old dad") — never omit this
- Ages must be accurate: if a sibling is described as older but still in elementary school, they are a child, not a teenager
- A 7-year-old looks like an actual 7-year-old: round face, small body, clearly a young child — taller than a 5-year-old but nowhere near adult or teenage height
- Do not round ages up or make children look older than they are
- Only include characters appearing in multiple scenes. Keep descriptions warm and child-appropriate. No markdown, no explanation — just the JSON.`;

  const raw = await callClaudeOpus(prompt, 800);
  try {
    let cleaned = raw.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
    return JSON.parse(cleaned);
  } catch(e) {
    console.error("designCharacters parse failed:", e.message);
    return { [name]: `a ${age}-year-old ${genderDesc} with ${hairDesc} hair and ${eye} eyes, wearing casual everyday clothes` };
  }
}

function generateCharacterSheet(imageUrl, childData) {
  const { name, age, gender } = childData;
  const payload = JSON.stringify({
    model: "gpt-4o",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: imageUrl } },
        { type: "text", text: `Describe all characters visible in this illustration in precise visual detail, for use as a consistent character reference across multiple illustrations. For each character, include: exact hair color, length, and style; eye color; skin tone; face shape; clothing colors and style; any distinguishing features. Be specific and use the kind of descriptive language an illustrator would use. Write 2-4 sentences total. Do not mention the background or setting. The main character is ${name}, age ${age}. If a companion, pet, or friend is visible, describe them too.` }
      ]
    }]
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.openai.com",
      port: 443,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(data.error.message));
          resolve(data.choices[0].message.content.trim());
        } catch(e) {
          reject(new Error("GPT-4o parse error: " + body.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("GPT-4o timeout")));
    req.write(payload);
    req.end();
  });
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
  const wordCount = (tier.chapCount * tier.wordsPerChap).toLocaleString();

  const chaptersHtml = chapters.map((chapText, ci) => {
    const lines = chapText.split(/\n+/).filter(l => l.trim());
    const fullTitle = lines[0] || `Chapter ${ci + 1}`;
    // Split "Chapter N: Title" into number and title
    const match = fullTitle.match(/^(Chapter \d+):\s*(.+)$/);
    const chapterNum = match ? match[1] : `Chapter ${ci + 1}`;
    const chapterTitle = match ? match[2] : fullTitle;

    const body = lines.slice(1).map(p => `<p>${p}</p>`).join('');

    // Check if this chapter has an illustration — skip 0-0 (that's the cover, already shown)
    const key = `${ci}-0`;
    const illustrationHtml = (illustrations[key] && ci > 0)
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
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 13pt; line-height: 1.9; color: #1a1a2e; }
  /* 5.5×8.5" digest trim size */
  @page {
    size: 5.5in 8.5in;
    margin: 18mm 18mm 20mm 22mm;
  }
  @page :left {
    size: 5.5in 8.5in;
    margin: 18mm 22mm 20mm 18mm;
  }
  @page :right {
    size: 5.5in 8.5in;
    margin: 18mm 18mm 20mm 22mm;
  }
  @page :first { size: 5.5in 8.5in; margin: 0; }

  /* ── COVER ── */
  .cover {
    width: 100%; height: 100vh;
    background: #1a3a2a;
    position: relative; overflow: hidden;
    page-break-after: always;
  }

  /* Full bleed illustration — fills entire cover */
  .cover-image {
    position: absolute; top: 0; left: 0;
    width: 100%; height: 100%;
    object-fit: cover;
  }

  /* Dark gradient from bottom — gives text contrast over the image */
  .cover-gradient {
    position: absolute; bottom: 0; left: 0;
    width: 100%; height: 65%;
    background: linear-gradient(to bottom, transparent 0%, rgba(10,30,20,0.7) 40%, rgba(10,30,20,0.95) 100%);
  }

  /* Text panel sits over the gradient at the bottom */
  .cover-panel {
    position: absolute; bottom: 0; left: 0;
    width: 100%;
    padding: 28px 48px 36px;
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
    color: rgba(255,255,255,0.75);
    letter-spacing: .04em;
    margin-bottom: 2px;
  }

  .cover-title-main {
    font-family: Georgia, serif;
    font-size: 28pt;
    font-weight: 900;
    color: #ffffff;
    line-height: 1.1;
    margin-bottom: 12px;
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

  .chapter { padding: 8px 0 40px; page-break-before: always; position: relative; }

  /* Page numbers */
  @page :left  { @bottom-left  { content: counter(page); font-family: Georgia, serif; font-size: 9pt; color: #9ca3af; } }
  @page :right { @bottom-right { content: counter(page); font-family: Georgia, serif; font-size: 9pt; color: #9ca3af; } }
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
    padding: 36px 0;
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
    ${illustrations['0-0'] ? `<img class="cover-image" src="${illustrations['0-0']}" />` : `<div style="position:absolute;top:0;left:0;width:100%;height:62%;background:linear-gradient(135deg,#2d6a4f,#1a3a2a);"></div>`}
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
  <div style="padding:32px 0;page-break-before:always;page-break-after:always;">
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
  // Page size controlled by CSS @page { size: 5.5in 8.5in } above — use_print:true ensures @page rules are applied
  const payload = JSON.stringify({
    source: html,
    landscape: false,
    use_print: true,
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
// FULL 30-CHAPTER PRINT PDF
// ════════════════════════════════════════════

async function generateFullBookPDF(childName, chapters, child, tier, illustrationsB64 = {}) {
  const { milestone, city, region, age } = child;
  const storyTitle = `${childName} and the ${getMilestoneTitle(milestone)}`;

  // Build all chapter HTML blocks
  const chaptersHtml = chapters.map((chapText, ci) => {
    const lines = chapText.split(/\n+/).filter(l => l.trim());
    const fullTitle = lines[0] || `Chapter ${ci + 1}`;
    const match = fullTitle.match(/^(Chapter \d+):\s*(.+)$/);
    const chapterNum = match ? match[1] : `Chapter ${ci + 1}`;
    const chapterTitle = match ? match[2] : fullTitle;
    const body = lines.slice(1).map(p => `<p>${p}</p>`).join('');
    const key = `${ci}-0`;
    // illustrationsB64 values are data URIs — embed directly, no network fetch by PDFShift
    const illustrationHtml = (illustrationsB64[key] && ci > 0)
      ? `<img src="${illustrationsB64[key]}" />`
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

  // Full TOC — all 30 chapters active, no grayed-out entries
  const tocRowsLeft = chapters.slice(0, 15).map((chapText, ci) => {
    const firstLine = chapText.split(/\n+/)[0] || '';
    const match = firstLine.match(/^Chapter (\d+):\s*(.+)$/);
    const num = match ? match[1] : String(ci + 1);
    const title = match ? match[2] : firstLine;
    return `<tr><td style="padding:5px 8px 5px 0;width:24px;font-size:8pt;color:#2d6a4f;font-weight:800;">${num}</td><td style="padding:5px 0;font-size:9pt;color:#1a1a2e;font-weight:600;">${title}</td></tr>`;
  }).join('');
  const tocRowsRight = chapters.slice(15, 30).map((chapText, ci) => {
    const firstLine = chapText.split(/\n+/)[0] || '';
    const match = firstLine.match(/^Chapter (\d+):\s*(.+)$/);
    const num = match ? match[1] : String(ci + 16);
    const title = match ? match[2] : firstLine;
    return `<tr><td style="padding:5px 8px 5px 0;width:24px;font-size:8pt;color:#2d6a4f;font-weight:800;">${num}</td><td style="padding:5px 0;font-size:9pt;color:#1a1a2e;font-weight:600;">${title}</td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 13pt; line-height: 1.9; color: #1a1a2e; }

  /* 5.5×8.5" digest trim size */
  @page { size: 5.5in 8.5in; margin: 18mm 18mm 20mm 22mm; }
  @page :first { size: 5.5in 8.5in; margin: 0; }
  @page :left  { size: 5.5in 8.5in; margin: 18mm 22mm 20mm 18mm; }
  @page :right { size: 5.5in 8.5in; margin: 18mm 18mm 20mm 22mm; }
  @page :left  { @bottom-left  { content: counter(page); font-family: Georgia, serif; font-size: 9pt; color: #9ca3af; } }
  @page :right { @bottom-right { content: counter(page); font-family: Georgia, serif; font-size: 9pt; color: #9ca3af; } }

  /* ── COVER ── */
  .cover { width:100%; height:100vh; background:#1a3a2a; position:relative; overflow:hidden; page-break-after:always; }
  .cover-image { position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover; }
  .cover-gradient { position:absolute; bottom:0; left:0; width:100%; height:65%; background:linear-gradient(to bottom, transparent 0%, rgba(10,30,20,0.7) 40%, rgba(10,30,20,0.95) 100%); }
  .cover-panel { position:absolute; bottom:0; left:0; width:100%; padding:28px 48px 36px; display:flex; flex-direction:column; justify-content:flex-end; gap:0; }
  .cover-badge { display:inline-block; background:#f9c74f; color:#1a1a2e; font-family:Arial,sans-serif; font-size:7.5pt; font-weight:800; letter-spacing:.12em; text-transform:uppercase; padding:4px 12px; border-radius:20px; margin-bottom:12px; width:fit-content; }
  .cover-title-line1 { font-family:Georgia,serif; font-size:12pt; font-weight:700; color:rgba(255,255,255,0.75); letter-spacing:.04em; margin-bottom:2px; }
  .cover-title-main { font-family:Georgia,serif; font-size:28pt; font-weight:900; color:#ffffff; line-height:1.1; margin-bottom:12px; }
  .cover-divider { width:40px; height:2px; background:rgba(255,255,255,0.25); margin-bottom:10px; }
  .cover-meta { font-family:Arial,sans-serif; font-size:8pt; color:rgba(255,255,255,0.45); line-height:1.5; margin-bottom:10px; }
  .cover-publisher { font-family:Arial,sans-serif; font-size:7.5pt; color:rgba(255,255,255,0.25); letter-spacing:.08em; text-transform:uppercase; }

  /* ── CHAPTERS ── */
  .chapter { padding:8px 0 40px; page-break-before:always; position:relative; }
  .chapter-number { font-family:Arial,sans-serif; font-size:8pt; font-weight:800; letter-spacing:.18em; text-transform:uppercase; color:#2d6a4f; margin-bottom:6px; }
  .chapter-title { font-family:Georgia,serif; font-size:${parseInt(age) <= 5 ? '22pt' : '18pt'}; color:#1a1a2e; margin-bottom:28px; line-height:1.2; }
  .chapter-divider { width:40px; height:3px; background:#2d6a4f; margin-bottom:28px; border-radius:2px; }
  .chapter-body p { font-family:Arial,sans-serif; font-size:${parseInt(age) <= 5 ? '14pt' : parseInt(age) <= 9 ? '13pt' : '12pt'}; line-height:${parseInt(age) <= 5 ? '2.2' : '2.0'}; font-weight:${parseInt(age) <= 9 ? '600' : '500'}; color:#1a1a2e; margin-bottom:${parseInt(age) <= 5 ? '1.4em' : '1.2em'}; text-align:left; }
  .chapter-body p:first-child::first-letter { font-family:Georgia,serif; font-size:4em; font-weight:900; color:#2d6a4f; float:left; line-height:0.75; margin-right:6px; margin-top:8px; }
  .chapter-body img { width:100%; max-width:320px; display:block; margin:2rem auto; border-radius:4px; }
  .chapter-end { text-align:center; color:#abc3b9; font-size:16pt; margin-top:2rem; }

  /* ── TITLE PAGE ── */
  .title-page { height:100vh; display:flex; flex-direction:column; justify-content:space-between; align-items:center; text-align:center; padding:36px 0; page-break-after:always; }
  .title-page-name { font-family:Arial,sans-serif; font-size:10pt; font-weight:800; letter-spacing:.15em; text-transform:uppercase; color:#2d6a4f; margin-bottom:1.5rem; }
  .title-page-title { font-family:Georgia,serif; font-size:28pt; font-weight:900; color:#1a1a2e; line-height:1.2; margin-bottom:1rem; }
  .title-page-divider { width:60px; height:2px; background:#e5e7eb; margin:0 auto 2.5rem; }
  .title-page-dedication { font-family:Arial,sans-serif; font-size:11pt; font-style:italic; color:#6b7280; line-height:1.8; }
</style>
</head>
<body>

  <!-- COVER -->
  <div class="cover">
    ${illustrationsB64['0-0'] ? `<img class="cover-image" src="${illustrationsB64['0-0']}" />` : `<div style="position:absolute;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#2d6a4f,#1a3a2a);"></div>`}
    <div class="cover-gradient"></div>
    <div class="cover-panel">
      <div class="cover-badge">A Growing Minds Original Story</div>
      <div class="cover-title-line1">${childName} and the</div>
      <div class="cover-title-main">${getMilestoneTitle(milestone)}</div>
      <div class="cover-divider"></div>
      <div class="cover-meta">Written for ${childName}, age ${age} &nbsp;&middot;&nbsp; ${city}, ${region}</div>
      <div class="cover-publisher">growingminds.io</div>
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
    <div style="font-family:Arial,sans-serif;font-size:8pt;color:#b0b8c1;letter-spacing:.06em;margin-top:auto;padding-top:40px;">Growing Minds &middot; growingminds.io &middot; &copy; ${new Date().getFullYear()}</div>
  </div>

  <!-- TABLE OF CONTENTS (all 30 chapters) -->
  <div style="padding:32px 0;page-break-before:always;page-break-after:always;">
    <div style="font-family:Arial,sans-serif;font-size:7pt;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#2d6a4f;margin-bottom:8px;">Contents</div>
    <div style="font-family:Georgia,serif;font-size:20pt;font-weight:900;color:#1a1a2e;margin-bottom:16px;">Table of Contents</div>
    <div style="width:36px;height:2px;background:#2d6a4f;margin-bottom:24px;border-radius:2px;"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 40px;">
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">${tocRowsLeft}</table>
      <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">${tocRowsRight}</table>
    </div>
  </div>

  ${chaptersHtml}

</body>
</html>`;

  console.log(`Full book HTML size: ${Math.round(html.length / 1024)}KB`);

  // Page size controlled by CSS @page { size: 5.5in 8.5in } above — use_print:true ensures @page rules are applied
  const payload = JSON.stringify({ source: html, landscape: false, use_print: true, sandbox: false });

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
      timeout: 240000  // 4 min — larger doc needs more time
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          const pdfBuffer = Buffer.concat(chunks);
          console.log(`Full book PDF generated: ${Math.round(pdfBuffer.length / 1024)}KB`);
          resolve(pdfBuffer.toString("base64"));
        } else {
          const body = Buffer.concat(chunks).toString();
          reject(new Error(`PDFShift full-book error ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("PDFShift full-book timeout")));
    req.write(payload);
    req.end();
  });
}

// ════════════════════════════════════════════
// EMAIL
// ════════════════════════════════════════════

async function sendPreviewEmail(email, childName, chapters, coverUrl, storyId, childData, upgradeUrl) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { milestone, city, region } = childData;
  const storyTitle = `${childName} and the ${getMilestoneTitle(milestone)}`;

  // Render chapters 1-3 as HTML blocks
  const previewChaps = (chapters || []).slice(0, 3);
  const chaptersHtml = previewChaps.map((chap, i) => {
    const text = typeof chap === 'object' ? (chap.text || '') : (chap || '');
    // Split into paragraphs
    const paras = text.split(/\n+/).filter(p => p.trim());
    const parasHtml = paras.map(p => {
      const trimmed = p.trim();
      // Chapter heading line
      if (/^chapter\s+\d+/i.test(trimmed)) {
        return `<h3 style="font-family:Georgia,serif;color:#2d6a4f;font-size:1.15rem;margin:1.8rem 0 .5rem;border-bottom:1px solid #d1fae5;padding-bottom:.4rem;">${trimmed}</h3>`;
      }
      return `<p style="font-family:Georgia,serif;font-size:1rem;line-height:1.8;color:#1a1a2e;margin:.75rem 0;">${trimmed}</p>`;
    }).join('');
    return `<div style="margin-bottom:1.5rem;">${parasHtml}</div>`;
  }).join('<hr style="border:none;border-top:2px dashed #d1fae5;margin:2rem 0;" />');

  const coverBlock = coverUrl
    ? `<div style="text-align:center;margin:2rem 0 1.5rem;">
        <img src="${coverUrl}" alt="${childName}'s story cover" style="max-width:300px;width:100%;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.15);" />
      </div>`
    : '';

  const cliffhanger = `<div style="background:#fefce8;border:2px solid #fde047;border-radius:12px;padding:1.25rem 1.5rem;margin:2rem 0;text-align:center;">
    <p style="font-size:1rem;font-weight:700;color:#854d0e;margin:0 0 .4rem;">🌟 The story is just getting started…</p>
    <p style="font-size:.9rem;color:#92400e;margin:0;">There are ${childData.age <= 5 ? '12' : childData.age <= 9 ? '17' : '27'} more chapters waiting for ${childName}. Get the complete personalized hardcover book, printed and shipped to your door.</p>
  </div>`;

  const ctaButton = `<div style="text-align:center;margin:1.5rem 0 2rem;">
    <a href="${upgradeUrl}" style="display:inline-block;background:#2d6a4f;color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:800;font-size:1.05rem;letter-spacing:.01em;box-shadow:0 3px 10px rgba(45,106,79,.3);">
      ✨ Get the Full Book — $32
    </a>
    <p style="font-size:.8rem;color:#6b7280;margin:.6rem 0 0;">Your $2.99 preview has already been credited toward the $35 total.</p>
  </div>`;

  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
      to: email,
      bcc: "purchase@growingminds.io",
      subject: `📖 Here's ${childName}'s story preview!`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;">
          <div style="background:#2d6a4f;padding:1.75rem 2rem;text-align:center;border-radius:12px 12px 0 0;">
            <p style="color:#86efac;font-size:.75rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin:0 0 .3rem;">Growing Minds</p>
            <h1 style="color:white;font-size:1.4rem;margin:0;font-family:Georgia,serif;">${storyTitle}</h1>
          </div>
          <div style="background:#fefae0;padding:1.5rem 2rem 2rem;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
            <p style="font-size:1rem;color:#374151;margin:.5rem 0 0;">Hi! Here are the first 3 chapters of ${childName}'s personalized story — created just for them. Read it together tonight!</p>

            ${coverBlock}
            ${chaptersHtml}
            ${cliffhanger}
            ${ctaButton}

            <div style="border-top:1px solid #e5e7eb;margin-top:2rem;padding-top:1rem;">
              <div style="background:white;border:1px solid #d1fae5;border-radius:8px;padding:.75rem 1rem;text-align:center;margin-bottom:1rem;">
                <div style="font-size:.7rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#16a34a;margin-bottom:.25rem;">Your Story ID</div>
                <div style="font-family:monospace;font-size:.95rem;font-weight:700;color:#14532d;">${storyId}</div>
                <p style="font-size:.75rem;color:#4b7c5a;margin:.3rem 0 0;">Keep this — use it if you order a sequel or a story for a sibling.</p>
              </div>
              <p style="color:#6b7280;font-size:.8rem;text-align:center;margin:0;">Questions? <a href="mailto:hello@growingminds.io" style="color:#2d6a4f;">hello@growingminds.io</a></p>
            </div>
          </div>
        </div>
      `
    });
    console.log(`Preview email sent to ${email} for ${childName} (${storyId})`);
  } catch(e) {
    console.error(`Preview email failed: ${e.message}`);
    throw e;
  }
}

async function sendDeliveryEmail(email, childName, pdfBase64, child, tier, storyId) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { milestone, city, region } = child;
  const wordCount = (tier.chapCount * tier.wordsPerChap).toLocaleString();
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

async function sendAdminNotificationEmail(storyId, customerEmail, childName, child, tier, fullBookUrl = null, coverImageUrl = null, previewChapter = null, token = '') {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { age, city, region, milestone, gender } = child;
  const storyTitle = `${childName} and the ${getMilestoneTitle(milestone)}`;
  const airtableUrl = `https://airtable.com/${process.env.AIRTABLE_BASE_ID || ''}`;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://growingminds.io';

  const fullBookButton = fullBookUrl
    ? `<a href="${fullBookUrl}" style="display:inline-block;background:#1a3a2a;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:.9rem;">Download Full Book PDF</a>`
    : `<span style="color:#9ca3af;font-size:.8rem;">Full book PDF not available — check Inngest logs.</span>`;

  const coverBlock = coverImageUrl ? `
    <div style="margin-bottom:1.5rem;">
      <p style="font-weight:700;color:#6b7280;font-size:.85rem;margin:0 0 8px;">COVER IMAGE</p>
      <a href="${coverImageUrl}" target="_blank">
        <img src="${coverImageUrl}" alt="Cover illustration" style="width:100%;max-width:320px;border-radius:6px;display:block;margin-bottom:6px;" />
      </a>
    </div>` : '';

  // First ~400 words of chapter 1 for quick spot-check
  const previewSnippet = previewChapter
    ? (() => {
        const words = previewChapter.split(/\s+/).slice(0, 400).join(' ');
        return `<div style="margin:1.5rem 0;padding:1rem 1.25rem;background:#f9fafb;border-left:3px solid #2d6a4f;border-radius:0 6px 6px 0;">
          <p style="font-weight:700;color:#6b7280;font-size:.8rem;margin:0 0 8px;">CHAPTER 1 PREVIEW</p>
          <p style="font-family:Georgia,serif;font-size:.9rem;line-height:1.7;color:#1a1a2e;margin:0;">${words}${previewChapter.split(/\s+/).length > 400 ? '…' : ''}</p>
        </div>`;
      })()
    : '';

  const approveUrl  = `${baseUrl}/api/approve?storyId=${storyId}&token=${token}`;
  const regenUrl    = `${baseUrl}/api/regenerate?storyId=${storyId}&token=${token}`;
  const cancelUrl   = `${baseUrl}/api/cancel?storyId=${storyId}&token=${token}`;

  const actionButtons = `
    <div style="margin:1.5rem 0;padding:1.25rem;background:#fefce8;border:1px solid #fde047;border-radius:8px;">
      <p style="font-weight:700;color:#854d0e;font-size:.9rem;margin:0 0 4px;">⏳ Story will auto-send in 2 hours</p>
      <p style="color:#92400e;font-size:.8rem;margin:0 0 1rem;">Review the chapter preview and cover above. Click below to act now.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <a href="${approveUrl}" style="display:inline-block;background:#16a34a;color:white;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-size:.9rem;">✓ Send Now</a>
        <a href="${regenUrl}" style="display:inline-block;background:#b45309;color:white;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-size:.9rem;">↺ Regenerate</a>
        <a href="${cancelUrl}" style="display:inline-block;background:#6b7280;color:white;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-size:.9rem;">✕ Cancel</a>
      </div>
    </div>`;

  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
      to: "hello@growingminds.io",
      subject: `⏳ Review before sending: ${storyTitle}`,
      html: `
        <div style="font-family:sans-serif;max-width:580px;margin:0 auto;color:#1a1a2e;">
          <div style="background:#2d6a4f;padding:1.5rem 2rem;border-radius:10px 10px 0 0;">
            <h2 style="color:white;margin:0;font-size:1.2rem;">New Story Ready — Review Required</h2>
          </div>
          <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:1.5rem 2rem;">
            <table style="border-collapse:collapse;width:100%;margin-bottom:1rem;">
              <tr style="border-bottom:1px solid #f3f4f6;"><td style="padding:8px 4px;font-weight:700;color:#6b7280;width:130px;font-size:.85rem;">STORY</td><td style="padding:8px 4px;font-weight:700;">${storyTitle}</td></tr>
              <tr style="border-bottom:1px solid #f3f4f6;"><td style="padding:8px 4px;font-weight:700;color:#6b7280;font-size:.85rem;">CHILD</td><td style="padding:8px 4px;">${childName}, age ${age} · ${gender || 'child'}</td></tr>
              <tr style="border-bottom:1px solid #f3f4f6;"><td style="padding:8px 4px;font-weight:700;color:#6b7280;font-size:.85rem;">LOCATION</td><td style="padding:8px 4px;">${city}, ${region}</td></tr>
              <tr style="border-bottom:1px solid #f3f4f6;"><td style="padding:8px 4px;font-weight:700;color:#6b7280;font-size:.85rem;">CUSTOMER</td><td style="padding:8px 4px;"><a href="mailto:${customerEmail}" style="color:#2d6a4f;">${customerEmail}</a></td></tr>
              <tr><td style="padding:8px 4px;font-weight:700;color:#6b7280;font-size:.85rem;">STORY ID</td><td style="padding:8px 4px;font-family:monospace;font-size:.85rem;">${storyId}</td></tr>
            </table>
            ${actionButtons}
            ${coverBlock}
            ${previewSnippet}
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:1.5rem;">
              <a href="${airtableUrl}" style="display:inline-block;background:#2d6a4f;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:.9rem;">View in Airtable</a>
              ${fullBookButton}
            </div>
          </div>
        </div>
      `
    });
    console.log(`Admin notification sent for ${childName} (${storyId})`);
  } catch(e) {
    console.error(`Admin notification failed: ${e.message}`);
  }
}

// ════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════

function callClaudeHaiku(prompt, maxTokens) {
  const payload = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
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
      timeout: 60000
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
          reject(new Error("Haiku parse error: " + body.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Haiku timeout")));
    req.write(payload);
    req.end();
  });
}

function callClaudeOnce(prompt, maxTokens) {
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
          if (data.error) return reject(new Error(data.error.message, { cause: data.error.type }));
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

async function callClaude(prompt, maxTokens, attempt = 0) {
  const MAX_RETRIES = 4;
  // Exponential backoff delays in ms: 30s, 60s, 120s, 240s
  const BACKOFF = [30000, 60000, 120000, 240000];
  try {
    return await callClaudeOnce(prompt, maxTokens);
  } catch(e) {
    const isOverloaded = e.message.toLowerCase().includes("overload") || e.message.toLowerCase().includes("529");
    if (isOverloaded && attempt < MAX_RETRIES) {
      const delay = BACKOFF[attempt];
      console.warn(`Claude overloaded (attempt ${attempt + 1}/${MAX_RETRIES}) — retrying in ${delay / 1000}s`);
      await new Promise(res => setTimeout(res, delay));
      return callClaude(prompt, maxTokens, attempt + 1);
    }
    throw e;
  }
}

// ── OPUS — used for all creative writing calls ──
function callClaudeOpusOnce(prompt, maxTokens) {
  const payload = JSON.stringify({
    model: "claude-opus-4-6",
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
      timeout: 300000  // 5 min — Opus is slower on long outputs
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(data.error.message, { cause: data.error.type }));
          resolve(data.content[0].text.trim());
        } catch(e) {
          reject(new Error("Claude Opus parse error: " + body.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Claude Opus timeout")));
    req.write(payload);
    req.end();
  });
}

async function callClaudeOpus(prompt, maxTokens, attempt = 0) {
  const MAX_RETRIES = 4;
  const BACKOFF = [30000, 60000, 120000, 240000];
  try {
    return await callClaudeOpusOnce(prompt, maxTokens);
  } catch(e) {
    const isOverloaded = e.message.toLowerCase().includes("overload") || e.message.toLowerCase().includes("529");
    if (isOverloaded && attempt < MAX_RETRIES) {
      const delay = BACKOFF[attempt];
      console.warn(`Claude Opus overloaded (attempt ${attempt + 1}/${MAX_RETRIES}) — retrying in ${delay / 1000}s`);
      await new Promise(res => setTimeout(res, delay));
      return callClaudeOpus(prompt, maxTokens, attempt + 1);
    }
    throw e;
  }
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
  // Store each image URL as a separate key
  for (const [key, url] of Object.entries(newIllustrations)) {
    await redisRequest("SET", [`img:${storyId}:${key}`, url, "EX", 7200]);
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
  try { return JSON.parse(Buffer.from(token, "base64url").toString("utf-8")); }
  catch { return null; }
}

async function saveStoryToAirtable(storyId, customerEmail, childName, child, chapters, fullBookUrl = null) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const token  = process.env.AIRTABLE_TOKEN;
  if (!baseId || !token) { console.log("No Airtable credentials — skipping story save"); return; }

  const { age, milestone, city, region } = child;
  const fullStory = chapters.join('\n\n---\n\n');
  const wordCount = fullStory.split(/\s+/).length;

  const fields = {
    "Story ID":   storyId,
    "Child Age":  parseInt(age) || 0,
    "Milestone":  milestone || "",
    "City":       `${city}, ${region}`,
    "Full Story": fullStory.slice(0, 100000), // Airtable long text limit — first ~20 chapters
    "Word Count": wordCount,
    "Created At": new Date().toISOString().split("T")[0]
  };
  // Full book PDF URL — complete 30-chapter print-ready file
  if (fullBookUrl) fields["Story PDF"] = fullBookUrl;

  const payload = JSON.stringify({ records: [{ fields }] });

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
        console.log(`Airtable Stories ${res.statusCode}: ${body.slice(0, 80)}`);
        resolve();
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── SERVE — must be after all function definitions ──
const handler = serve({ client: inngest, functions: [generateStoryOrder, generatePreviewChapters, generateRemainingChapters] });
module.exports = handler;
