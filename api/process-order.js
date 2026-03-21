// api/process-order.js
const https = require("https");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { storyToken, childName, storyId, customerEmail } = req.body;
  const childData = decodeStoryData(storyToken);

  if (!childData) {
    console.error("Could not decode story token");
    return res.status(400).json({ error: "Invalid token" });
  }

  try {
    console.log(`Generating story for ${childName}`);
    const fullStory = await generateFullStory(childData);
    console.log(`Story done — ${fullStory.length} chars`);

    const pdfBytes = await createStoryPDF(childData, fullStory);
    console.log(`PDF created — ${pdfBytes.length} bytes`);

    const downloadUrl = await storePDFAndGetLink(pdfBytes, storyId);
    console.log(`PDF stored: ${downloadUrl}`);

    if (customerEmail) {
      await sendDeliveryEmail(customerEmail, childName, downloadUrl);
      console.log(`Email sent to ${customerEmail}`);
    }

    console.log(`✅ Complete for ${childName}`);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("process-order error:", err.message);
    console.error(err.stack);
    return res.status(500).json({ error: err.message });
  }
};

// ── GENERATE STORY via raw https (no SDK) ──
async function generateFullStory(child) {
  const { name, age, gender, hair, hairLength, hairStyle, eye, trait, favorite, friend, city, region, milestone } = child;
  const genderPronoun = gender === "girl" ? "she/her" : gender === "boy" ? "he/him" : "they/them";
  const friendLine = friend && friend !== "none" ? `Their pet or best friend's name is ${friend}.` : "";
  const hairDesc = [hairLength, hairStyle, hair].filter(Boolean).join(", ").toLowerCase();
  const wordCount = parseInt(age) <= 6 ? "300-400" : parseInt(age) <= 9 ? "400-500" : "500-600";

  const prompt = `Write a short children's story (exactly 150 words) for a ${age}-year-old named ${name} who lives in ${city}, ${region}. Their milestone is: ${milestone}. Include their ${hairDesc} hair and ${eye} eyes. Favorite thing: ${favorite}.${friendLine} Warm, encouraging tone. No title.`;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 300,
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
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(data.error.message));
          resolve(data.content[0].text.trim());
        } catch (e) {
          reject(new Error("Failed to parse Anthropic response: " + body));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => reject(new Error("Anthropic API timeout")));
    req.write(payload);
    req.end();
  });
}

// ── CREATE PDF ──
async function createStoryPDF(child, storyText) {
  const { name, age, city, region, milestone } = child;
  const pdfDoc = await PDFDocument.create();
  const timesRoman = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const timesBold  = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const helvetica  = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const pageWidth = 432, pageHeight = 648, margin = 54;
  const contentW = pageWidth - margin * 2;

  const cover = pdfDoc.addPage([pageWidth, pageHeight]);
  cover.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: rgb(0.176, 0.416, 0.310) });
  cover.drawText(`${name} and the`, { x: margin, y: pageHeight * 0.65, font: timesBold, size: 28, color: rgb(1,1,1) });
  cover.drawText(getMilestoneTitle(milestone), { x: margin, y: pageHeight * 0.65 - 38, font: timesBold, size: 28, color: rgb(0.976, 0.780, 0.310) });
  cover.drawText("A Growing Minds Original Story", { x: margin, y: pageHeight * 0.65 - 80, font: helvetica, size: 11, color: rgb(0.8, 0.9, 0.85) });
  cover.drawText(`Written for ${name}, age ${age}`, { x: margin, y: pageHeight * 0.3, font: timesBold, size: 13, color: rgb(1,1,1) });
  cover.drawText(`${city}, ${region}`, { x: margin, y: pageHeight * 0.3 - 20, font: timesRoman, size: 11, color: rgb(0.8, 0.9, 0.85) });
  cover.drawText("growingminds.io", { x: margin, y: margin, font: helvetica, size: 10, color: rgb(0.6, 0.8, 0.7) });

  const paragraphs = storyText.split(/\n+/).filter(p => p.trim());
  let page = null, cursorY = 0, pageNum = 1;
  const lineH = 18, fontSize = 13, topY = pageHeight - margin, bottomY = margin + 30;

  function newPage() { page = pdfDoc.addPage([pageWidth, pageHeight]); cursorY = topY; }
  newPage();

  for (const para of paragraphs) {
    const words = para.split(" ");
    let line = "", lines = [];
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (timesRoman.widthOfTextAtSize(test, fontSize) > contentW && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    cursorY -= 10;
    if (cursorY - lines.length * lineH < bottomY) {
      page.drawText(`${pageNum++}`, { x: pageWidth/2-5, y: margin-15, font: timesRoman, size: 10, color: rgb(0.6,0.6,0.6) });
      newPage();
    }
    for (const l of lines) {
      if (cursorY < bottomY) {
        page.drawText(`${pageNum++}`, { x: pageWidth/2-5, y: margin-15, font: timesRoman, size: 10, color: rgb(0.6,0.6,0.6) });
        newPage();
      }
      page.drawText(l, { x: margin, y: cursorY, font: timesRoman, size: fontSize, color: rgb(0.1,0.1,0.15) });
      cursorY -= lineH;
    }
  }
  return await pdfDoc.save();
}

function getMilestoneTitle(milestone) {
  const map = {
    "Starting kindergarten": "Brave New Day", "Learning to read": "Magic of Words",
    "Losing a first tooth": "Wobbly Tooth", "Riding a bike without training wheels": "Great Bike Ride",
    "Starting middle school": "New Adventure", "Dealing with anxiety or school pressure": "Brave Heart",
    "Trying something scary or new": "Leap of Courage", "Navigating friendships and social dynamics": "Friend Quest",
    "Joining a sports team or club": "Big Team", "Dealing with big feelings or frustration": "Feeling Storm",
    "Standing up for themselves or a friend": "Brave Stand", "Taking on a new responsibility at home": "Big Helper",
    "Learning to use the potty": "Big Step", "Starting preschool or daycare": "First Day",
    "Making a new friend": "Hello, Friend", "Sharing with others": "Giving Heart",
  };
  return map[milestone] || "Big Adventure";
}

async function storePDFAndGetLink(pdfBytes, storyId) {
  // Return PDF bytes directly — attach to email instead of storing in Blob
  return pdfBytes;
}

async function sendDeliveryEmail(email, childName, pdfBytes) {
  const { Resend } = require("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const base64PDF = Buffer.from(pdfBytes).toString("base64");
  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
    to: email,
    subject: `${childName}'s story is ready! 🌟`,
    attachments: [{
      filename: `${childName}-story.pdf`,
      content: base64PDF,
    }],
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e;">
        <div style="background:#2d6a4f;padding:2rem;text-align:center;border-radius:12px 12px 0 0;">
          <h1 style="color:white;font-size:1.5rem;margin:0;">🌱 Growing Minds</h1>
        </div>
        <div style="background:#fefae0;padding:2rem;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;">
          <h2 style="color:#2d6a4f;">${childName}'s story is ready! ✨</h2>
          <p>We've written a one-of-a-kind adventure just for ${childName}. The PDF is attached — open it and read it together tonight!</p>
          <p style="color:#6b7280;font-size:.9rem;margin-top:1.5rem;">Your printed book is also on its way and will arrive in 5–10 business days.</p>
          <p style="color:#6b7280;font-size:.85rem;margin-top:2rem;">Questions? Email us at hello@growingminds.io</p>
        </div>
      </div>
    `
  });
}

function decodeStoryData(token) {
  try { return JSON.parse(Buffer.from(token, "base64url").toString("utf-8")); }
  catch { return null; }
}
