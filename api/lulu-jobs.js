// api/lulu-jobs.js — TEMPORARY diagnostic endpoint, delete after use
// Requires ?secret=ADMIN_WEBHOOK_SECRET in the query string for basic protection
const { luluRequest } = require("./lulu");

// Page count estimates per tier (text pages + illustration pages + front matter)
const PAGE_COUNTS = {
  small:  { label: "Age ≤5 (15 chapters)",  pages: 90  },
  medium: { label: "Age 6–9 (20 chapters)", pages: 120 },
  large:  { label: "Age 10+ (30 chapters)", pages: 170 },
};

const PACKAGES = {
  "BW Standard":    "0550X0850.BW.STD.PB.060UW444.MXX",
  "BW Premium":     "0550X0850.BW.PRE.PB.060UW444.MXX",
  "Color Standard": "0550X0850.FC.STD.PB.080CW444.MXX",
  "Color Premium":  "0550X0850.FC.PRE.PB.080CW444.MXX",
};

async function getCost(podPackageId, pageCount) {
  try {
    const result = await luluRequest("POST", "/print-job-cost-calculations/", {
      line_items: [{ pod_package_id: podPackageId, quantity: 1, page_count: pageCount }],
      shipping_option_level: "GROUND",
      currency: "USD",
    });
    const cost = result?.line_item_costs?.[0];
    return cost
      ? `$${parseFloat(cost.cost_excl_discounts).toFixed(2)} + $${parseFloat(result.shipping_cost?.cost_excl_discounts || 0).toFixed(2)} shipping`
      : "N/A";
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

module.exports = async function handler(req, res) {
  const secret = req.query.secret;
  if (!secret || secret !== process.env.ADMIN_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const sandbox = process.env.LULU_SANDBOX === "true";
    const costs = {};

    for (const [tierKey, tier] of Object.entries(PAGE_COUNTS)) {
      costs[tier.label] = {};
      for (const [pkgName, pkgId] of Object.entries(PACKAGES)) {
        costs[tier.label][pkgName] = await getCost(pkgId, tier.pages);
      }
    }

    return res.status(200).json({ sandbox, costs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
