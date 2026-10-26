// check-batch-full.js — run manually, once, with a real GEMINI_API_KEY.
//
// Submits a SMALL real batch job (2 tiny image requests, bundled into one
// batch per the shape already validated in check-batch.js) and polls it to
// completion, printing the raw response at every step. The goal is to see
// the ACTUAL field names Gemini uses for job state and for where completed
// results live — search results and third-party reports disagree with each
// other (BATCH_STATE_* vs JOB_STATE_*, inlinedResponses vs dest, etc.), and
// there's a live bug report of batch jobs with inline image requests coming
// back SUCCEEDED with results missing. This finds out directly rather than
// building production code against a guess.
//
// USAGE:
//   node check-batch-full.js                  — submit a new job, then poll it
//   node check-batch-full.js batches/XXXXXXX   — resume polling an existing job
//                                                 (use this instead of
//                                                 re-running with no args, so
//                                                 you don't submit — and pay
//                                                 for — a second job)
//
// Saves the job name to ./check-batch-job.json as soon as it's created, and
// the full final response to ./check-batch-result.json once it completes,
// so nothing is lost if you need to stop and resume polling later.

const https = require("https");
const fs = require("fs");

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Set GEMINI_API_KEY first: GEMINI_API_KEY=... node check-batch-full.js");
  process.exit(1);
}

const JOB_FILE = "./check-batch-job.json";
const RESULT_FILE = "./check-batch-result.json";
const POLL_INTERVAL_MS = 30 * 1000;      // 30s between checks
const MAX_POLLS = 120;                    // 60 minutes total before giving up

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function submitJob() {
  const referenceImageBase64 = fs.readFileSync("./some-test-reference.jpg").toString("base64");

  const body = {
    batch: {
      display_name: "check-batch-full-test",
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
              metadata: { key: "test-a" }
            },
            {
              request: {
                contents: [{
                  parts: [
                    { text: "A child reading a book under a tree, storybook illustration style." },
                    { inlineData: { mimeType: "image/jpeg", data: referenceImageBase64 } }
                  ]
                }],
                generationConfig: { imageConfig: { aspectRatio: "4:3", imageSize: "2K" } }
              },
              metadata: { key: "test-b" }
            }
          ]
        }
      }
    }
  };

  console.log("Submitting batch job with 2 requests...");
  const res = await request(
    "POST",
    `/v1beta/models/gemini-3-pro-image:batchGenerateContent?key=${API_KEY}`,
    body
  );
  console.log(`Submit status: ${res.status}`);
  console.log(JSON.stringify(res.body, null, 2));

  if (res.status !== 200 || !res.body?.name) {
    console.error("\nSubmission failed or returned no job name — stopping, nothing to poll.");
    process.exit(1);
  }

  fs.writeFileSync(JOB_FILE, JSON.stringify({ name: res.body.name, submittedAt: new Date().toISOString() }, null, 2));
  console.log(`\nJob name: ${res.body.name}`);
  console.log(`Saved to ${JOB_FILE}. Polling now...\n`);
  return res.body.name;
}

async function pollJob(jobName) {
  for (let i = 1; i <= MAX_POLLS; i++) {
    const res = await request("GET", `/v1beta/${jobName}?key=${API_KEY}`);
    const state = res.body?.metadata?.state || res.body?.state || "(no state field found)";
    console.log(`[Poll ${i}/${MAX_POLLS}] status=${res.status} state=${state} done=${res.body?.done}`);

    // Treat anything with "SUCCEED", "FAIL", "CANCEL", or "EXPIR" in the state
    // name as terminal, since we don't yet know the exact enum prefix in use.
    const terminal = typeof state === "string" && /SUCCEED|FAIL|CANCEL|EXPIR/i.test(state);
    if (res.body?.done === true || terminal) {
      console.log("\n=== TERMINAL STATE REACHED — full raw response below ===\n");
      console.log(JSON.stringify(res.body, null, 2));
      fs.writeFileSync(RESULT_FILE, JSON.stringify(res.body, null, 2));
      console.log(`\nSaved full response to ${RESULT_FILE}.`);
      console.log("Paste the contents of that file back to Claude to confirm the real shape.");
      return;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log(`\nStill not done after ${MAX_POLLS} polls (~${(MAX_POLLS * POLL_INTERVAL_MS) / 60000} min).`);
  console.log(`Re-run later with: node check-batch-full.js ${jobName}`);
}

(async () => {
  const resumeJobName = process.argv[2];
  const jobName = resumeJobName || (await submitJob());
  await pollJob(jobName);
})().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
