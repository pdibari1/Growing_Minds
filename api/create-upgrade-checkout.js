// api/create-upgrade-checkout.js — $32 upgrade checkout (full book, $2.99 already credited)
const Stripe = require("stripe");

const UPGRADE_PRICE_CENTS = 3200; // $35 total minus $2.99 preview = $32.01 → rounded to $32

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { storyId, childName, customerEmail } = req.body;
  if (!storyId || !childName) return res.status(400).json({ error: "Missing required fields" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          unit_amount: UPGRADE_PRICE_CENTS,
          product_data: {
            name: `${childName}'s Personalized Story Book — Full Edition`,
            description: "Complete personalized hardcover book (your $2.99 preview payment has been credited). Printed and shipped in 13–15 business days.",
          },
        },
        quantity: 1,
      }],
      shipping_address_collection: {
        allowed_countries: ["US", "CA", "GB", "AU"],
      },
      customer_email: customerEmail || undefined,
      metadata: {
        storyId,
        childName,
        customerEmail: customerEmail || '',
        payment_type: 'upgrade',
      },
      success_url: `${process.env.NEXT_PUBLIC_BASE_URL}/confirmation.html?session_id={CHECKOUT_SESSION_ID}&sid=${storyId}&name=${encodeURIComponent(childName)}`,
      cancel_url: `${process.env.NEXT_PUBLIC_BASE_URL}/upgrade.html?sid=${storyId}&name=${encodeURIComponent(childName)}`,
    });

    return res.status(200).json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Stripe upgrade checkout error:", error);
    return res.status(500).json({ error: "Could not create upgrade session." });
  }
};
