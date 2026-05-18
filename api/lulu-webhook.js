// api/lulu-webhook.js — receives PRINT_JOB_STATUS_CHANGED events from Lulu
// Register this URL once via: POST https://api.lulu.com/webhooks/
// with { url: "https://growingminds.io/api/lulu-webhook", topics: ["PRINT_JOB_STATUS_CHANGED"] }

const { Resend } = require("resend");

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisRequest(command, args) {
  const res = await fetch(`${REDIS_URL}/${command}/${args.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  return (await res.json()).result;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const event = req.body;
  const { topic, data } = event || {};

  if (topic !== "PRINT_JOB_STATUS_CHANGED") {
    return res.status(200).json({ received: true });
  }

  const jobId = data?.print_job?.id;
  const status = data?.print_job?.status?.name;

  console.log(`Lulu webhook: job ${jobId} → ${status}`);

  if (!jobId || !status) return res.status(200).json({ received: true });

  // Look up which storyId this job belongs to
  // We stored lulu-job:{storyId} = jobId — need reverse lookup
  // Simplest: store both directions
  const storyId = await redisRequest("GET", [`lulu-job-story:${jobId}`]);

  if (storyId) {
    await redisRequest("SET", [`lulu-status:${storyId}`, status, "EX", 2592000]);
  }

  // If shipped, send a tracking email to the customer
  if (status === "SHIPPED" && storyId) {
    try {
      const customerEmail = await redisRequest("GET", [`customeremail:${storyId}`]);
      const childName     = await redisRequest("GET", [`childname:${storyId}`]);

      const trackingUrls = data?.print_job?.status?.line_item_statuses
        ?.flatMap(li => li.messages?.tracking_urls || []) || [];
      const trackingUrl  = trackingUrls[0] || null;
      const carrier      = data?.print_job?.status?.line_item_statuses?.[0]?.messages?.carrier_name || "the carrier";

      if (customerEmail) {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: "Growing Minds <hello@growingminds.io>",
          to: customerEmail,
          subject: `📦 ${childName}'s book is on its way!`,
          html: `
            <div style="font-family:'Nunito',sans-serif;max-width:560px;margin:0 auto;padding:2rem;">
              <h2 style="color:#2d6a4f;">Your book is on its way! 🎉</h2>
              <p style="color:#374151;line-height:1.6;">
                <strong>${childName}'s</strong> personalized story book has been printed and handed off to ${carrier}.
                It should arrive within 5–10 business days.
              </p>
              ${trackingUrl ? `
              <p style="margin-top:1.5rem;">
                <a href="${trackingUrl}" style="background:#2d6a4f;color:#fff;padding:0.85rem 2rem;border-radius:999px;text-decoration:none;font-weight:700;display:inline-block;">
                  Track your package →
                </a>
              </p>` : ""}
              <p style="margin-top:2rem;font-size:.85rem;color:#9ca3af;">
                Questions? Reply to this email or contact us at hello@growingminds.io
              </p>
            </div>
          `,
        });
        console.log(`Shipping email sent to ${customerEmail} for ${storyId}`);
      }
    } catch(e) {
      console.error(`Shipping email failed: ${e.message}`);
    }
  }

  return res.status(200).json({ received: true });
};
