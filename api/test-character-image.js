// api/test-character-image.js — Prototype/test endpoint for Gemini 2.5 Flash Image character consistency.
// NOT wired into the live purchase flow — for manual side-by-side comparison against the current
// gpt-image-1 pipeline before committing to a full-order redesign.
//
// Usage: POST /api/test-character-image?secret=ADMIN_WEBHOOK_SECRET
// Body: { name, age, hair, hairLength, hairStyle, eye, city, region, genre, scenes: ["scene 1", "scene 2", ...] }
// "scenes" is optional — defaults to 3 sample scenes if omitted.
//
// Returns URLs for one character-reference image plus one image per scene, so they can be
// opened side by side to judge identity consistency and scene/action accuracy.

const https = require("https");
const { put } = require("@vercel/blob");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secret = req.query.secret;
  if (!secret || secret !== process.env.ADMIN_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { name, age, hair, hairLength, hairStyle, eye, city, region, genre, scenes } = req.body || {};
  if (!name || !hair || !eye) {
    return res.status(400).json({ error: "name, hair, and eye are required" });
  }

  const testId = `test_${Date.now()}`;
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const charDesc = `${name}, a young child, age ${age || "7"}, with ${hairDesc} hair and ${eye} eyes`;

  const baseStyle = "Heroic storybook character illustration, Pixar-style 3D glossy render, high production quality. Character is charismatic, confident, and adventurous. Face: large expressive eyes with a confident, purposeful gaze. Pose: dynamic and open, strong recognizable silhouette. Lighting: warm cinematic illumination with luminous rim light.";

  const defaultScenes = [
    `${name} discovering a hidden door in an old library, reaching out with wonder`,
    `${name} running through a sunlit meadow, laughing, arms outstretched`,
    `${name} standing at the edge of a cliff at sunset, looking out determinedly`,
  ];
  const testScenes = (Array.isArray(scenes) && scenes.length > 0) ? scenes : defaultScenes;

  try {
    const results = { testId, scenes: [] };

    // Step 1: Generate the character reference ("character sheet") image.
    const refPrompt = `${baseStyle}\n\nCharacter reference sheet. Full body, front-facing, neutral pose, clear view of face and outfit. ${charDesc}. Setting: ${city || "a small town"}, ${region || ""}${genre ? `. Story style: ${genre}` : ""}. No text or letters in the image.`;
    const refImage = await callGeminiImage([{ text: refPrompt }]);
    const refBlob = await put(`test-character/${testId}/reference.png`, refImage.bytes, {
      access: "public",
      contentType: refImage.mimeType,
    });
    results.reference = refBlob.url;
    console.log(`Reference image generated: ${refBlob.url}`);

    // Step 2: Generate each scene, feeding the reference image back in for consistency.
    for (let i = 0; i < testScenes.length; i++) {
      const scenePrompt = `${baseStyle}\n\nThis is the SAME character shown in the reference image — keep hair, eyes, face, and outfit identical. New scene: ${testScenes[i]}. No text or letters in the image.`;
      const sceneImage = await callGeminiImage([
        { inlineData: { mimeType: refImage.mimeType, data: refImage.bytes.toString("base64") } },
        { text: scenePrompt },
      ]);
      const sceneBlob = await put(`test-character/${testId}/scene-${i}.png`, sceneImage.bytes, {
        access: "public",
        contentType: sceneImage.mimeType,
      });
      results.scenes.push({ prompt: testScenes[i], url: sceneBlob.url });
      console.log(`Scene ${i} generated: ${sceneBlob.url}`);
    }

    return res.status(200).json({ success: true, ...results });
  } catch (err) {
    console.error("Character consistency test failed:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Gemini 2.5 Flash Image API call ──
// `parts` follows Gemini's generateContent content-part format: [{ text }] and/or
// [{ inlineData: { mimeType, data (base64) } }] for reference images.
// Returns { bytes: Buffer, mimeType: string } for the first image part in the response.
function callGeminiImage(parts) {
  const payload = JSON.stringify({ contents: [{ parts }] });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      path: "/v1beta/models/gemini-2.5-flash-image:generateContent",
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
