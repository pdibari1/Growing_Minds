// api/alert-lib.js — shared admin failure-alert email, used by api/inngest.js
// (every Inngest-driven step) and api/generate-preview.js (the one customer-
// facing failure path that runs before Inngest is ever involved).
const { Resend } = require("resend");

async function sendAlertEmail(subject, details) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    // The Resend SDK does NOT throw on API-level errors (bad recipient, domain
    // issue, rate limit, etc.) — it resolves normally with { data: null, error }.
    // Without this check, a rejected send looks identical to a successful one.
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Growing Minds <stories@growingminds.io>",
      to: process.env.ADMIN_ALERT_EMAIL || "hello@growingminds.io",
      subject: `⚠️ ${subject}`,
      text: details
    });
    if (error) throw new Error(error.message || JSON.stringify(error));
    console.log(`Alert email sent: ${subject} (id: ${data?.id})`);
  } catch (e) {
    console.error(`Alert email failed to send: ${e.message}`);
  }
}

module.exports = { sendAlertEmail };
