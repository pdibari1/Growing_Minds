// scratch-check-batch-support.js — run manually, once, with a real GEMINI_API_KEY.
// Submits ONE request to Gemini's batch endpoint with a reference image attached,
// to answer: does gemini-3-pro-image accept batch jobs with image input at all?
// This only tests whether the job is ACCEPTED at submission — it doesn't wait for
// or pay for the actual generation, so a rejection costs nothing.

const https = require("https");
const fs = require("fs");

const API_KEY = process.env.GEMINI_API_KEY;
const referenceImageBase64 = fs.readFileSync("./some-test-reference.jpg").toString("base64");

const body = JSON.stringify({
  batch: {
    display_name: "batch-support-check",
    input_config: {
      requests: {
        requests: [
          {
            request: {
              contents: [{
                parts: [
                  { text: "A child in a sunny meadow, storybook illustration style." },
                  { inlineData: { mimeType: "image/jpeg", data: referenceImageBase64 } }
                ]
              }],
              generationConfig: { imageConfig: { aspectRatio: "4:3", imageSize: "2K" } }
            },
            metadata: { key: "test-1" }
          }
        ]
      }
    }
  }
});

const req = https.request({
  hostname: "generativelanguage.googleapis.com",
  path: `/v1beta/models/gemini-3-pro-image:batchGenerateContent?key=${API_KEY}`,
  method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
}, (res) => {
  let data = "";
  res.on("data", c => data += c);
  res.on("end", () => {
    console.log(`Status: ${res.statusCode}`);
    console.log(data);
    // A 400 naming an unsupported model or unsupported input type = not batch-eligible.
    // A 200 with a batch job name/ID back = accepted, and the question is answered
    // without ever letting the job actually run or generate anything.
  });
});
req.on("error", console.error);
req.write(body);
req.end();