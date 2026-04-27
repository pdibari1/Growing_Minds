// api/create-preview-checkout.js — $4.99 preview checkout (3 chapters, credited toward full book)
const Stripe = require("stripe");

const PREVIEW_PRICE_CENTS = 499;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { childName, storyId, customerEmail, customDetails } = req.body;
  if (!childName || !storyId) return res.status(400).json({ error: "Missing required fields" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: PREVIEW_PRICE_CENTS,
          product_data: {
            name: `${childName}'s Story Preview — First 3 Chapters`,
            description: "Read the opening 3 chapters of your personalized story. $4.99 is credited toward the full $35 hardcover book.",
          },
        },
        quantity: 1,
      }],
      // No shipping — digital delivery
      metadata: {
        storyId,
        childName,
        customerEmail: customerEmail || '',
        customDetails: (customDetails || '').slice(0, 500),
        payment_type: 'preview',
      },
      success_url: `${process.env.NEXT_PUBLIC_BASE_URL}/confirmation.html?type=preview&sid=${storyId}&name=${encodeURIComponent(childName)}`,
      cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL}/story-preview.html?cancelled=true`,
    });

    return res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Stripe preview checkout error:", error);
    return res.status(500).json({ error: "Could not create checkout session." });
  }
};
