// api/create-checkout.js
const Stripe = require("stripe");

const PRICE_CENTS = 3500;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { childName, storyId, discountCode, customerEmail, customDetails } = req.body;

  if (!childName || !storyId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    // Look up discount code if provided
    let discounts = [];
    if (discountCode && discountCode.trim()) {
      try {
        const promotionCodes = await stripe.promotionCodes.list({
          code: discountCode.trim().toUpperCase(),
          active: true,
          limit: 1
        });
        if (promotionCodes.data.length > 0) {
          discounts = [{ promotion_code: promotionCodes.data[0].id }];
        } else {
          return res.status(400).json({ error: "Invalid or expired discount code." });
        }
      } catch(err) {
        console.error("Promo code lookup error:", err.message);
        return res.status(400).json({ error: "Could not apply discount code." });
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: PRICE_CENTS,
          product_data: {
            name: `${childName}'s Personalized Story Book`,
            description: "Includes instant PDF download + printed hardcover book shipped to your door",
          },
        },
        quantity: 1,
      }],
      discounts: discounts.length > 0 ? discounts : undefined,
      allow_promotion_codes: discounts.length === 0, // Show promo field in Stripe UI if no code pre-applied
      shipping_address_collection: {
        allowed_countries: ["US", "CA", "GB", "AU"],
      },
      // storyToken is stored in Redis (key: token:{storyId}) — kept out of metadata to avoid Stripe's 500-char limit
      metadata: { storyId, childName, customerEmail: customerEmail || '', customDetails: (customDetails || '').slice(0, 500) },
      success_url: `${process.env.NEXT_PUBLIC_BASE_URL}/confirmation?session_id={CHECKOUT_SESSION_ID}&sid=${storyId}&name=${encodeURIComponent(childName)}`,
      cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL}/story-preview?cancelled=true`,
    });

    return res.status(200).json({ checkoutUrl: session.url });

  } catch (error) {
    console.error("Stripe error:", error);
    return res.status(500).json({ error: "Could not create checkout session." });
  }
};
