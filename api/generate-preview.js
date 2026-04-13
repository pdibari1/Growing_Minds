// api/generate-preview.js
const Anthropic = require("@anthropic-ai/sdk");
const https = require("https");

// ── Tier (must match inngest.js) ──
function getStoryTier(age) {
  const a = parseInt(age);
  if (a <= 5) return { chapCount: 15, wordsPerChap: 500, label: "illustrated chapter book" };
  if (a <= 9) return { chapCount: 20, wordsPerChap: 700, label: "chapter book" };
  return       { chapCount: 30, wordsPerChap: 800, label: "novel" };
}

// ── Redis (Upstash REST) ──
async function redisRequest(command, args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
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
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(body).result); }
        catch { resolve(null); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Redis timeout")));
    req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone, email, customDetails, ethnicity } = req.body;

  if (!name || !age || !trait || !favorite || !city || !milestone) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Basic content safety check on free-text fields
  // Use word-boundary regex so short words like "ass" don't match inside "classic", "grass", etc.
  const flaggedWords = ['fuck', 'shit', 'bitch', 'ass', 'damn', 'hell', 'sex', 'porn', 'kill', 'murder', 'suicide', 'drug', 'cocaine', 'meth', 'weed', 'nude', 'naked'];
  const allFreeText = `${name} ${trait} ${favorite} ${friend || ''} ${customDetails || ''}`.toLowerCase();
  const flagged = flaggedWords.some(w => new RegExp(`\\b${w}\\b`).test(allFreeText));
  if (flagged) {
    return res.status(400).json({ error: "Your submission contains inappropriate content. Please review your entries and try again." });
  }

  const genderPronoun = gender === "girl" ? "she/her" : gender === "boy" ? "he/him" : "they/them";
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const friendLine = friend && friend !== "none" ? `Their companion (pet, best friend, or sibling): ${friend}.` : "";
  const tier = getStoryTier(age);
  const storyId = "story_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const customLine = customDetails ? `\nCRITICAL CUSTOM DETAILS — follow these exactly:\n${customDetails}` : "";

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Step 1: Generate a cheap story seed with Haiku — just the arc in a few sentences.
    // This is what ties the preview to the real story without paying for a full Sonnet outline
    // for every visitor who might not convert.
    const seedPrompt = `You are a children's book author planning a ${tier.label} for a ${age}-year-old.

Hero: ${name}, ${genderPronoun}, loves ${favorite}. ${friendLine}
Hometown: ${city}, ${region}.
Milestone/theme: ${milestone}.
${customLine}

Write a 4-6 sentence story arc that covers: how the story opens, the main challenge ${name} faces, a key low point, and how it resolves. Be specific to this child's details. This is a planning note, not prose.

Rules:
- Named companions (${friend && friend !== "none" ? friend : "none"}) are only ever warm and supportive — never obstacles or antagonists
- No smartphones, cell phones, or devices exist in this world
- All conflict comes from the milestone challenge itself, not from unkind friends
- Use character names exactly as given — never invent nicknames, never write that anyone dislikes or hates a name or nickname
- No teasing, mocking, or unkind banter between any characters

Return only the arc summary, no title or labels.`;

    const seedMsg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      messages: [{ role: "user", content: seedPrompt }]
    });
    const storySeed = seedMsg.content[0].text.trim();

    // Cache the seed for 48 hours — if the customer buys, inngest.js uses it to
    // build the real outline so the story follows the same arc the customer saw.
    try {
      await redisRequest("SET", [`seed:${storyId}`, storySeed, "EX", 172800]);
    } catch (e) {
      console.warn("Redis seed cache failed (non-fatal):", e.message);
    }

    // Step 2: Write the preview opening from the seed — cliffhanger at end of chapter 1.
    const previewPrompt = `You are a warm, imaginative children's book author. Write the opening of a personalized children's ${tier.label}.

Hero: ${name}, age ${age}, ${genderPronoun}, ${hairDesc} hair, ${eye} eyes.
Personality: ${trait}. Loves: ${favorite}. ${friendLine}
Hometown: ${city}, ${region} — use broad geography naturally, never specific street names or addresses.
${customLine}

STORY DIRECTION — your preview must set up this arc:
${storySeed}

RULES:
- Named characters are never mean or unkind — they only appear being warm and supportive
- No smartphones, cell phones, tablets, or personal devices exist in this world
- No assumed disabilities for any character
- NAMES AND NICKNAMES: Use every character's name exactly as written. Only use a nickname if the custom details explicitly state one. Never invent nicknames. Never write that a character dislikes, hates, or is embarrassed by a nickname or their name — if a nickname exists it is always used warmly and affectionately
- No teasing, mocking, or playful insults between characters — all banter must be warm and kind
- SAFETY: Never include anything inappropriate for children

INSTRUCTIONS:
- Write exactly 180-220 words — the opening of chapter 1
- Use age-appropriate language (${parseInt(age) <= 6 ? "simple, warm, read-aloud style" : parseInt(age) <= 9 ? "early chapter book style" : "middle grade style"})
- EMOTIONAL CEILING: ${parseInt(age) <= 7 ? `${name} is ${age} years old. The maximum negative emotion in this opening is a small flutter of nerves or a brief moment of uncertainty — nothing deeper. Any worried feeling must be immediately balanced with warmth, excitement, or comfort. ${name} may feel a little nervous but NEVER devastated, crushed, or deeply sad. The tone must feel cozy and brave even as it builds toward the cliffhanger.` : parseInt(age) <= 9 ? `Emotions can be real but must be clearly passing. The tone stays warm and hopeful even at the cliffhanger.` : `Full emotional range appropriate for this age.`}`
- Open in medias res — drop us right into ${name}'s world
- Weave in the physical details (hair, eye color), the hometown, the favorite thing, and the companion naturally
- Build toward the milestone challenge laid out in the story direction — but DO NOT resolve it
- End on a genuine cliffhanger — the last sentence must leave the reader desperate to know what happens next
- Do NOT write a title or chapter heading
- Write only the story text, nothing else`;

    const previewMsg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      messages: [{ role: "user", content: previewPrompt }]
    });
    const previewText = previewMsg.content[0].text.trim();

    const storyToken = Buffer.from(JSON.stringify({
      name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone, storyId, ethnicity: ethnicity || ''
    })).toString("base64url");

    return res.status(200).json({ preview: previewText, storyToken, storyId, childName: name, customerEmail: email, customDetails: customDetails || '' });

  } catch (error) {
    console.error("Preview generation error:", error);
    return res.status(500).json({ error: "Story generation failed. Please try again." });
  }
};
