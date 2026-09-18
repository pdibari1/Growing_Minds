// api/lulu-cost-check.js — Admin diagnostic: get a REAL Lulu print+shipping quote
// via Lulu's own cost-calculation endpoint, using the real account credentials and
// POD_PACKAGE_ID already wired up in api/lulu.js. This is a quote-only call — it
// never creates a print job or charges anything.
//
// Usage: POST /api/lulu-cost-check?secret=ADMIN_WEBHOOK_SECRET
// Body: {
//   pageCount,               // required — interior page count
//   quantity,                // optional, default 1
//   shippingLevel,           // optional, default "GROUND" — MAIL | PRIORITY_MAIL | GROUND | EXPEDITED | EXPRESS
//   podPackageId,            // optional — override to test standard vs premium color, etc.
//   address: { city, state, postal_code, country }  // optional — defaults to a sample US address
// }
//
// Returns Lulu's raw response — includes print cost, shipping cost, and total,
// broken out separately. Field names come straight from Lulu, so read the raw
// JSON rather than assuming a shape here.

const { luluRequest, POD_PACKAGE_ID } = require("./lulu.js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secret = req.query.secret;
  if (!secret || secret !== process.env.ADMIN_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const {
    pageCount, quantity = 1, shippingLevel = "GROUND",
    podPackageId = POD_PACKAGE_ID, address = {}
  } = req.body || {};

  if (!pageCount) {
    return res.status(400).json({ error: "pageCount is required" });
  }

  try {
    const result = await luluRequest("POST", "/print-job-cost-calculations/", {
      line_items: [{
        pod_package_id: podPackageId,
        page_count: pageCount,
        quantity
      }],
      shipping_address: {
        city: address.city || "New York",
        state_code: address.state || "NY",
        country_code: address.country || "US",
        postcode: address.postal_code || "10001",
        street1: "123 Main St"
      },
      shipping_level: shippingLevel
    });

    return res.status(200).json({ ok: true, podPackageId, pageCount, quantity, shippingLevel, result });
  } catch (err) {
    console.error("[lulu-cost-check] error:", err.message);
    // Lulu's error body is included in err.message — if this is a 400 about an
    // unrecognized field, that's Lulu telling us the exact expected shape.
    return res.status(500).json({ error: err.message });
  }
};
