// api/lulu-jobs.js — TEMPORARY diagnostic endpoint, delete after use
// Requires ?secret=ADMIN_WEBHOOK_SECRET in the query string for basic protection
const { getLuluToken, luluRequest } = require("./lulu");

module.exports = async function handler(req, res) {
  const secret = req.query.secret;
  if (!secret || secret !== process.env.ADMIN_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Confirm which environment we're hitting
    const sandbox = process.env.LULU_SANDBOX === "true";

    // Fetch the 10 most recent print jobs
    const jobs = await luluRequest("GET", "/print-jobs/?page_size=10&ordering=-date_created");

    return res.status(200).json({ sandbox, jobs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
