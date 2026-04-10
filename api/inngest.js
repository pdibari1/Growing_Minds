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

// ── ILLUSTRATION STYLE — one universal style for all stories ──
// Single DALL-E 3 style used for both cover and all chapter illustrations.
const STYLE_GUIDE = "Bold outlined digital illustration with rich painted colors and detailed shading — like a high-quality animated feature film. Strong clean ink lines, vivid saturated palette, expressive characters with detailed faces and lush detailed backgrounds. Bright well-lit scene. No text, words, signs, labels, color swatches, paint palettes, art supplies, pencils, brushes, or design elements anywhere in the image. No hands holding brushes or pens. No artist creating or drawing the scene. No meta-depiction of the image being made.";

function getStyleGuide() {
  return STYLE_GUIDE;
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

    // Step 1: Generate chapter outline — pull preview story seed from Redis if available
    const rawOutline = await step.run("generate-outline", async () => {
      // Check for a story seed cached by generate-preview.js — if present, pass it to
      // generateOutline so the real story follows the same arc the customer saw in the preview.
      const seed = await redisRequest("GET", [`seed:${storyId}`]);
      if (seed) {
        console.log(`Using preview story seed for ${storyId}`);
        await redisRequest("DEL", [`seed:${storyId}`]);
      }
      const result = await generateOutline(childData, tier, seed || null);
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(result), "EX", 7200]);
      console.log(`Saved outline with ${result.length} chapters to Redis`);
      return result;
    });

    // Step 1b: Sanitize outline — replace any named friend in a conflict/unkindness role with an unnamed character
    const outline = await step.run("sanitize-outline", async () => {
      const friendNames = namedCharacters.filter(n => n !== childName);
      if (friendNames.length === 0) return rawOutline;
      const sanitized = await sanitizeOutline(rawOutline, friendNames);
      // Overwrite Redis so chapter batches use the sanitized version
      await redisRequest("SET", [`outline:${storyId}`, JSON.stringify(sanitized), "EX", 7200]);
      console.log(`Outline sanitized — ${sanitized.length} chapters`);
      return sanitized;
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
        let batchChapters = await generateChapterBatch(childData, outline, start, end, priorChapters, tier);

        // Deterministic regex enforcement: replace any unapproved diminutive with the full name
        batchChapters = batchChapters.map(ch =>
          enforceFullNamesRegex(ch, childData.namedCharacters, childData.parsedCustomDetails)
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

      // Step A: Use Claude to design ALL recurring characters with consistent descriptions
      const castDescriptions = await step.run("design-characters", async () => {
        const cast = await designCharacters(childData, freshOutline);
        await redisRequest("SET", [`cast:${storyId}`, JSON.stringify(cast), "EX", 7200]);
        console.log(`Designed ${Object.keys(cast).length} characters: ${Object.keys(cast).join(', ')}`);
        return cast;
      });

      // Build cast reference string for prompts
      const buildCastRef = (cast) => Object.entries(cast).map(([n, d]) => `${n}: ${d}`).join('. ');

      // Step B: Generate cover image, then refine main character description via GPT-4o
      const finalCast = await step.run("generate-cover-and-character-sheet-v4", async () => {
        // Pick a dramatic hero moment from ~65% through the story (climax area)
        const heroMomentIdx = Math.min(Math.floor(freshOutline.length * 0.65), freshOutline.length - 1);
        const heroMomentChap = freshOutline[heroMomentIdx] || freshOutline[0];
        const coverPrompt = `${styleGuide} IMPORTANT: The main character is a CHILD, age ${age} — render with the face, body proportions, and size of a real ${age}-year-old ${genderDesc}. NOT a teenager. NOT an adult. A young child, age ${age}. Character: ${name}, ${lockedCharDesc}.${longHairBoyNote} HAIR: ${name}'s hair is ${hair}-colored and ${hairLengthExpanded}. The hair length is critical — it must be clearly and visibly ${hairLengthExpanded}. Do not shorten the hair. ${name} stands smiling in a wide open ${region} outdoor scene with mountains and sky. Single continuous scene. No insets, no secondary images, no borders, no picture frames, no color swatches, no paint palettes, no art supplies, no pencils, no brushes, no design elements of any kind floating in the image.`;
        const coverUrl = await callDallE(coverPrompt);
        const coverBytes = await fetchImageBytes(coverUrl);
        const blob = await put(`illustrations/${storyId}/0-0.jpg`, coverBytes, { access: 'public', contentType: 'image/jpeg' });
        await saveIllustrationsToRedis(storyId, { '0-0': blob.url });
        // Store cover URL separately with a 7-day TTL — the illustration key (2h) may expire
        // before notify-admin runs on long stories. This key is never deleted by cleanup.
        await redisRequest("SET", [`cover:${storyId}`, blob.url, "EX", 604800]);
        console.log(`Cover image generated: ${blob.url.slice(0, 60)}`);

        // Use GPT-4o to refine secondary character descriptions from the cover
        // BUT always keep the user's specified physical attributes for the main character
        try {
          const refined = await generateCharacterSheet(blob.url, childData);
          // Lock main character to user-specified attrs — GPT-4o can only help with secondary chars
          const merged = { ...castDescriptions, [name]: lockedCharDesc };
          console.log(`Character sheet done — ${name} locked to user attrs: ${lockedCharDesc}`);
          return merged;
        } catch(e) {
          console.error(`Character sheet refinement failed, using locked attrs: ${e.message}`);
          return { ...castDescriptions, [name]: lockedCharDesc };
        }
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

          // Scene prompt: character appearance comes from the reference image, so just describe the scene
          // Hair length is included as a hint to help the model preserve it from the reference
          const scenePrompt = `${chap?.imagePrompt || `${name} having fun outdoors in ${city}`} Setting: ${city}, ${region}. The main character has ${hairLengthExpanded} ${hair}-colored hair — preserve this exactly from the reference image. Cheerful, bright daytime scene. Bold outlined digital illustration with rich painted colors — like a high-quality animated feature film. No text, signs, or words anywhere in the image.`;

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

    // Step 7c: Wait up to 2 hours for admin approval — auto-sends if no action taken
    await step.waitForEvent("wait-for-approval", {
      event: "story/approved",
      match: "data.storyId",
      timeout: "2h"
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
      await redisRequest("DEL", [`cast:${storyId}`]);
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

// ── SERVE ──
const handler = serve({ client: inngest, functions: [generateStoryOrder] });
module.exports = handler;

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

async function generateOutline(child, tier, storySeed = null) {
  const { name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone, customDetails, parsedCustomDetails } = child;
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
` : "";

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

STORY RULES — apply to every chapter summary:
- STICK TO KNOWN DETAILS: Only reference specific real-world details — teacher names, school names, pet names, sibling names, home layout, routines, hobbies, family traditions — if they are explicitly provided in the child's profile or custom details. For anything not specified, keep it general so it cannot clash with the child's real life. Write "his teacher" not an invented name. Write "a place he loved" not an invented location. If it's not in the profile, leave it vague.
- NAMED CHARACTERS — STRICT RULE: ${namedCharactersStr} may only appear in a chapter summary when they are actively helping, joining in, or enthusiastically encouraging ${name} in exactly what ${name} is trying to do. Named friends must NEVER: be unkind, exclude, or mock anyone; choose to do a different project, activity, or idea from ${name}; express doubt or hesitation about ${name}'s plan; or go off to do their own thing while ${name} works alone. Any scene involving conflict, social difficulty, or diverging choices must use only ${name} and completely unnamed characters ("a classmate", "some kids"). Named characters exist to be on ${name}'s team — always.
- NO PHONES OR DEVICES: This story world has no smartphones, cell phones, tablets, or personal devices — for anyone, children or adults. Nobody sends or receives texts, messages, or notifications. If characters need to communicate, they talk in person or pass a handwritten note.
- NO ASSUMED DISABILITIES: Do not give any named character a wheelchair, mobility aid, prosthetic limb, visual impairment, hearing aid, or any other physical disability or adaptive device unless it is explicitly stated in the child's profile or custom details. This applies to ${name} and all named friends.

CONFLICT SOURCE — this is critical: All tension and difficulty comes from the milestone challenge itself — self-doubt, the difficulty of the task, bad luck, time pressure. Named friends never appear in conflict scenes. All conflict involves only ${name} and unnamed characters.

${storySeed ? `STORY ARC DIRECTION — the customer already read a preview based on this arc. Your outline MUST follow this same general direction so the full story matches what they were shown:
${storySeed}

` : ""}This is a ${tier.chapCount}-chapter ${tier.label} (~${(tier.chapCount * tier.wordsPerChap).toLocaleString()} words total). Structure the arc across all ${tier.chapCount} chapters:
- Opening (first 20%): Introduce ${name} and their world, establish the milestone challenge
- Rising action (middle 50%): Complications, obstacles, self-doubt, setbacks — driven by the challenge itself, not by friends being unkind
- Climax (next 20%): Highest stakes, darkest moment of doubt, breakthrough
- Resolution (final 10%): Triumph over the milestone, heartwarming ending

You MUST return EXACTLY ${tier.chapCount} chapters — no more, no fewer.

Return ONLY a valid JSON array of EXACTLY ${tier.chapCount} objects. Each object must have:
- "title": chapter title WITHOUT chapter number (4-6 words, evocative e.g. "The Day Everything Changed")
- "summary": 2-3 sentence summary of what happens
- "imagePrompt": a 1-sentence description of the key visual moment in this chapter (for illustration) — describe only cheerful, positive, bright, well-lit moments (e.g. exploring outdoors, building something, celebrating, helping a friend). Always daytime or warmly lit indoor scenes. No nighttime scenes, dark rooms, moonlit windows, or dim lighting. No danger, peril, conflict, or emotionally intense scenes.

No markdown, no explanation, just the JSON array.`;

  const raw = await callClaude(prompt, 6000);
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

CRITICAL: This chapter must follow directly from what came before and lead naturally into the next. Stay true to the established characters, setting, and tone. Do not introduce unrelated premises.
CHARACTERS: Every person mentioned — siblings, friends, pets, parents — must be portrayed warmly and positively. No eye-rolling, dismissiveness, mockery, or negativity from any character toward another.
NAMED FRIENDS IN CHAPTERS: If any of ${namedCharactersStr} appear, they must be actively on ${name}'s side — joining in, helping, or cheering for exactly what ${name} is doing. They must NEVER choose a different project or activity, express doubt about ${name}'s plan, or go off to do their own thing. Any character who diverges from ${name}'s goal must be given an unnamed label ("a classmate", "another kid") — never a protected name.

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
  const { name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone, customDetails, parsedCustomDetails } = child;
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
` : "";

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

RULES:
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
- AGE & GRADE LOGIC: Derive school grades strictly from age (age 5 = Kindergarten, age 6–7 = Grade 1–2, etc.). Children of different ages are never in the same grade unless they are twins or custom details say otherwise. "Going to school together" = same school building, not same grade. Never write that a younger child is joining or catching up to an older child's grade.
- Writing style: ${parseInt(age) <= 5 ? "Warm, lyrical, read-aloud. Short paragraphs. Sensory detail." : parseInt(age) <= 9 ? "Engaging, age-appropriate. Mix of action, humor, emotion." : "Rich vocabulary, complex emotions. Feels like a real middle-grade novel."}
${isLastBatch ? "- The final chapter must resolve the milestone beautifully with warmth and hope. End on a warm, satisfying, conclusive note — no cliffhanger on the last chapter." : "- CHAPTER ENDINGS — CLIFFHANGERS: Every chapter except the last must end on a moment that makes the reader desperate to turn the page. This does NOT mean danger or darkness — it means unresolved anticipation. Good chapter-ending techniques: a surprising discovery just made, a question just asked with no answer yet shown, an unexpected arrival, a decision that must be made by next chapter, a sound or sight that raises a question, a small moment of hope or dread just as something is about to happen. The very last sentence of each chapter should feel incomplete — like the story just leaned forward. Never end a chapter with a character going to sleep, summarizing what happened, or wrapping up the scene neatly."}
- SAFETY: This is a children's book. Never include swear words, sexual content, or graphic violence. All stories must resolve with hope and warmth.
- STICK TO KNOWN DETAILS: Only use specific real-world details — teacher names, school names, pet names, sibling names, home layout, daily routines, specific hobbies, family traditions — if they are explicitly provided in the child's profile or custom details above. For anything not specified, use general language instead of inventing specifics. Say "his teacher" not "Ms. Johnson". Say "their house" not invented room names. Say "a book she loved" not a specific title. If a detail is not in the profile, keep it vague so it cannot clash with the child's real life.
- NAMED CHARACTERS IN POSITIVE SCENES ONLY: ${namedCharactersStr} may only appear in scenes where they are actively helping, encouraging, or sharing a warm moment with ${name}. They must NEVER appear in any scene involving conflict, difficulty, unkindness, or social tension — not as the cause, not as bystanders, not as observers. When writing any scene that involves struggle, exclusion, or unkind behavior, write as if the named characters do not exist. Use only ${name} and completely unnamed characters ("a classmate", "some kids", "another child") for conflict scenes. The named characters exist in this story only to be supportive — they are not plot devices for conflict.
- NO PHONES OR DEVICES: This story world has no smartphones, cell phones, tablets, or personal devices — for anyone, children or adults. Nobody sends or receives texts, messages, or notifications. If characters need to communicate, they talk in person or pass a handwritten note.
${customReminder}
Write all ${endIdx - startIdx} chapters now. Nothing else.`;

  const raw = await callClaude(prompt, tier.maxTokensPerChap * (endIdx - startIdx) + 500);

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

      const retryRaw = await callClaude(retryPrompt, tier.maxTokensPerChap + 300);
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

  const styleGuide = getStyleGuide();

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

async function callFalInstantCharacter(referenceImageUrl, scenePrompt) {
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

  // Poll for completion (up to 3 minutes, every 4 seconds)
  const statusUrl = `https://queue.fal.run/fal-ai/instant-character/requests/${request_id}/status`;
  const resultUrl = `https://queue.fal.run/fal-ai/instant-character/requests/${request_id}`;
  const deadline = Date.now() + 180000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
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
      return await fetchImageBytes(imageUrl);
    }

    if (status.status === 'FAILED') {
      throw new Error(`fal.ai generation failed: ${JSON.stringify(status.error || status).slice(0, 200)}`);
    }
  }

  throw new Error("fal.ai instant-character timed out after 3 minutes");
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
  const { name, age, gender, hair, hairLength, hairStyle, eye, friend } = childData;
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const genderDesc = gender === "girl" ? "girl" : gender === "boy" ? "boy" : "child";
  const friendLine = friend && friend !== "none" ? `\nCompanion/pet: ${friend}.` : "";

  const imagePrompts = outline.map((c, i) => `Ch${i + 1}: ${c.imagePrompt}`).join('\n');

  const prompt = `You are designing characters for a children's illustrated book. Your job is to assign consistent physical descriptions to all recurring characters so an illustrator can draw them the same way every time.

Known main character: ${name}, ${age}-year-old ${genderDesc}, ${hairDesc} hair, ${eye} eyes.${friendLine}

Chapter scene descriptions (used to identify all characters):
${imagePrompts}

Task:
1. Identify every distinct character who appears in 2 or more chapter scenes (siblings, friends, antagonists, pets, teachers, etc.)
2. For each recurring character, create a specific, consistent physical description (hair, eyes, skin, clothing style, distinguishing features)
3. Also write the definitive description for ${name} using their known details

Return ONLY a valid JSON object. Keys are character names, values are 1-2 sentence physical descriptions. Example:
{
  "${name}": "a ${age}-year-old ${genderDesc} with ${hairDesc} hair and ${eye} eyes, wearing a blue hoodie and jeans",
  "Jake": "a stocky 9-year-old boy with short red hair, pale freckled skin, and a green t-shirt",
  "Biscuit": "a fluffy golden retriever with floppy ears and a red collar"
}

Only include characters appearing in multiple scenes. Keep descriptions warm and child-appropriate. No markdown, no explanation — just the JSON.`;

  const raw = await callClaude(prompt, 800);
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
    margin: 18mm 18mm 20mm 22mm; /* top outside bottom gutter(left on odd) */
  }
  @page :left {
    margin: 18mm 22mm 20mm 18mm; /* gutter on right for even pages */
  }
  @page :right {
    margin: 18mm 18mm 20mm 22mm; /* gutter on left for odd pages */
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
  @page :left  { margin: 18mm 22mm 20mm 18mm; }
  @page :right { margin: 18mm 18mm 20mm 22mm; }
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

function callClaude(prompt, maxTokens) {
  const payload = JSON.stringify({
    model: "claude-sonnet-4-20250514",
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
