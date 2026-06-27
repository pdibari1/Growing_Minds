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

THIS IS A PORTAL FANTASY. The story follows this exact structure:
1. REAL WORLD OPENING: ${name} is in their ordinary life, and the milestone (${milestone}) is approaching — they may feel excited, nervous, or uncertain about it.
2. THE MAGIC HAPPENS: Something connected to ${name}'s love of ${favorite} comes to life, glows, speaks, or opens a door. This is the portal. It is unexpected and wondrous. Examples: a stuffed dinosaur blinks and leads them through a crack in the wall; a book about space opens onto a real star map; a toy castle door swings open to reveal a glowing staircase. Make it specific to ${favorite}.
3. ANOTHER WORLD: ${name} crosses into a completely different world — a fantasy realm built entirely around ${favorite}. This world has its own name, creatures, landscape, and rules. It is nothing like home.
4. THE MIRROR CHALLENGE: In this world, ${name} faces a challenge that emotionally mirrors the real milestone — but in fantastical terms. If the milestone is about belonging somewhere new, ${name} must earn a place in a magical community. If it's about welcoming something new and vulnerable, ${name} must protect a young magical creature. If it's about being brave, ${name} must complete a quest that requires exactly that. The challenge is never the literal milestone — it is the emotional heart of it, played out in fantasy.
5. LOW POINT: Something goes wrong. ${name} doubts themselves.
6. BREAKTHROUGH: ${name} finds what they need — courage, patience, love — and resolves the challenge.
7. RETURN HOME: ${name} returns to the real world changed. They now face the real milestone (${milestone}) with new confidence because of what they experienced.

Hero: ${name}, ${genderPronoun}, loves ${favorite}. ${friendLine}
Real milestone: ${milestone}
${customLine}

Write a 5-7 sentence story arc covering all 7 steps above. Be specific to this child. Name the fantasy world. Describe the portal mechanism (what specifically comes to life or opens). Describe the mirror challenge in the fantasy world. This is a planning note, not prose.

Rules:
- Named companions (${friend && friend !== "none" ? friend : "none"}) are only ever warm and supportive
- No smartphones or devices
- All conflict comes from the mirror challenge, not from unkind friends
- Use character names exactly as given

Return only the arc summary, no title or labels.`;

    const seedMsg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
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
    const ageNum = parseInt(age);
    const emotionalCeilingNote = ageNum <= 7
      ? (name + " is " + age + " years old. The maximum negative emotion in this opening is a small flutter of nerves or a brief moment of uncertainty — nothing deeper. Any worried feeling must be immediately balanced with warmth, excitement, or comfort. " + name + " may feel a little nervous but NEVER devastated, crushed, or deeply sad. The tone must feel cozy and brave even as it builds toward the cliffhanger.")
      : ageNum <= 9
      ? "Emotions can be real but must be clearly passing. The tone stays warm and hopeful even at the cliffhanger."
      : "Full emotional range appropriate for this age.";
    const previewPrompt = `You are a warm, imaginative children's book author. Write the opening chapter of a personalized children's ${tier.label}.

THIS IS A PORTAL FANTASY. The opening chapter must follow this exact structure:
- PART A — REAL WORLD: Open with ${name} in their ordinary life. The milestone (${milestone}) is close — they may feel a mix of excitement and nerves. Keep real-world details generic (no invented specifics about their home, street, or possessions). Establish who ${name} is: their personality, their love of ${favorite}, their companion if any.
- PART B — THE MAGIC BEGINS: Something connected to ${name}'s love of ${favorite} does something impossible. It glows, moves, speaks, or reveals a hidden door. This is the moment the real world cracks open. Be specific and wondrous — make it feel inevitable, like it was always going to happen.
- CLIFFHANGER: End the chapter at the threshold — ${name} is about to step through, fall in, or be pulled away — but the chapter ends before they cross over. The reader must desperately want to know what's on the other side.

STORY ARC (follow this — it describes what comes after this opening chapter):
${storySeed}

Hero: ${name}, age ${age}, ${genderPronoun}, ${hairDesc} hair, ${eye} eyes.
Personality: ${trait}. Loves: ${favorite}. ${friendLine}
${customLine}

RULES:
- REAL WORLD DETAILS: In the real-world section, only use details explicitly provided. Never invent specifics — not their bedroom décor, their backpack, what's on their shelf, what food they're eating. Generic is always safe: "their room," "their things," "beside their bed."
- NEVER INVENT ATTRIBUTES OF REAL PEOPLE: Only describe named friends or siblings using details explicitly provided. If it wasn't stated, don't write it.
- Named characters are never mean or unkind — only warm and supportive
- No smartphones, cell phones, or personal devices
- No assumed disabilities for any character
- NAMES AND NICKNAMES: Use every character's name exactly as written. Never invent nicknames.
- No teasing or unkind banter between any characters
- PHYSICAL DETAILS: If custom details describe a character's hair, use exactly those details.
- SAFETY: Nothing inappropriate for children

INSTRUCTIONS:
- Write exactly 180-220 words
- Use age-appropriate language (${parseInt(age) <= 6 ? "simple, warm, read-aloud style" : parseInt(age) <= 9 ? "early chapter book style" : "middle grade style"})
- EMOTIONAL CEILING: ${emotionalCeilingNote}
- Do NOT write a title or chapter heading
- Write only the story text, nothing else`;

    const previewMsg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content: previewPrompt }]
    });
    const previewText = previewMsg.content[0].text.trim();

    const storyToken = Buffer.from(JSON.stringify({
      name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone, storyId, ethnicity: ethnicity || ''
    })).toString("base64url");

    // Cache the storyToken for 48 hours so the webhook can retrieve it via storyId.
    // Stripe metadata has a 500-char limit per value; the token often exceeds that.
    try {
      await redisRequest("SET", [`token:${storyId}`, storyToken, "EX", 172800]);
    } catch (e) {
      console.warn("Redis token cache failed (non-fatal):", e.message);
    }

    return res.status(200).json({ preview: previewText, storyToken, storyId, childName: name, customerEmail: email, customDetails: customDetails || '' });

  } catch (error) {
    const status = error.status || error.statusCode || 500;
    console.error(`Preview generation error (HTTP ${status}):`, error.message || error);
    if (status === 529 || (error.message || "").toLowerCase().includes("overload")) {
      return res.status(503).json({ error: "Our story engine is busy right now. Please wait a moment and try again." });
    }
    return res.status(500).json({ error: "Story generation failed. Please try again." });
  }
};
