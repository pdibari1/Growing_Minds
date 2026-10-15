# Growing Minds — Project Status

_Last updated: 2026-10-08._

## What this is

Growing Minds — personalized children's story books. A customer fills out an
intake form about their child, gets a short AI-written cliffhanger preview for
free, can pay $2.99 for the first 3 chapters by email, and/or buys the full
30-chapter illustrated story for $35 (standard) or $50 (premium color) —
delivered as a PDF plus a print-on-demand softcover book shipped via Lulu.

- **Hosting:** Vercel (`vercel --prod`), domain `growingminds.io`
- **Story text:** Claude (`@anthropic-ai/sdk`)
- **Illustrations:** Gemini `gemini-3-pro-image` ("Nano Banana Pro") — this
  **is** the production path (`api/inngest.js`, `api/generate-preview.js`),
  with reference-image conditioning for character consistency across a
  book's cover and interior scenes. `api/test-character-image.js` is a
  separate admin diagnostic tool, not the production path.
- **Payments:** Stripe — preview checkout ($2.99), full-order checkout
  ($35/$50), upgrade checkout ($32/$47). **Currently running in Stripe TEST
  mode** — no real payments are being collected yet.
- **Print fulfillment:** Lulu Direct — real integration built and wired in
  (not a stub). **Currently running with `LULU_SANDBOX=true`** — no real
  print jobs or charges yet. Delivery is gated behind a manual admin
  approval step (see below) before anything goes to print.
- **Background jobs:** Inngest (`api/inngest.js`)
- **Storage:** Vercel Blob (images/PDFs) + Upstash Redis (story tokens,
  outlines, chapter drafts, illustration URLs — all storyId-keyed, mostly
  30-day TTL)
- **Lead capture / archive:** Airtable
- **Email:** Resend
- **PDF:** pdfshift (HTML→PDF) + `pdf-lib` + `satori`/`@resvg/resvg-js`
- **Analytics:** GA4 (`G-P6FLSR57GV`), with the Express/Signature intake
  flows separated by page title, `track_selected` event, and `form_type`
  event parameter

See `DEPLOYMENT.md` for the deploy runbook and API request/response shapes.
See `env.example.txt` for the full list of required environment variables.
See `CLAUDE.md` for the key-files table and architecture conventions.

## Current operational state (what's real vs. still a dry run)

- **Stripe: TEST mode.** No real customer payments yet.
- **Lulu: SANDBOX mode.** No real print jobs or charges yet.
- **Admin-approval gate is live:** every full order pauses after generation
  (up to 7 days) for a human to click "Approve & Send" in a review email
  before the customer is notified and the book goes to print. This exists
  because the admin reviewing the book has no way to independently verify
  factual details (companion species, named people, appearance) without
  cross-referencing the actual intake answers — which the review email now
  includes.
- **Lulu's webhook is registered against sandbox only.** Re-run
  `POST /api/register-lulu-webhook?secret=...` once `LULU_SANDBOX` flips to
  `false`, since sandbox and live are separate registrations.
- Still testing with outside testers before flipping Stripe and Lulu live
  together (doing one without the other risks real print jobs for orders
  that never collected real payment).

## Known per-book costs (confirmed, not estimated)

- **Illustrations (Gemini):** standard real-time pricing is $0.134/image at
  1K/2K, $0.24/image at 4K (used for covers). Current interior images run
  at 2K. Per book today: **$0.78 (age >9, 5 images) to $2.12 (age ≤5, 15
  images)**, depending on age tier's image count.
- **Batch/flex pricing** (confirmed compatible with the reference-image
  character-consistency setup, and confirmed via real Google Cloud billing
  at ~$0.067/image for 2K) is **half the standard rate**. Decision made:
  route all full-order **interior** image generation through batch
  (already async in the background, no UX cost) — the **cover** stays on
  real-time generation (needs to feel instant on the free preview page).
  Not yet implemented.
- **Lulu print cost** (confirmed via `/api/lulu-cost-check` against Lulu's
  real cost-calculation endpoint, for a 150-page book, print cost only —
  excludes shipping/tax): **~$9.57 standard, ~$22.83 premium color**.
- **Not yet quantified:** Claude text generation cost per book, Lulu
  shipping + tax, Vercel/Blob/Resend overhead.

## Open items

- Age-tuned psychological approach for young readers (age ≤5) — co-regulation
  framing and explicit emotion-naming — is built (`api/inngest.js`).
- Bibliotherapy mechanism in the story prompts, parent discussion bridge,
  milestone-arc depth, and an outside expert review pass are all still
  open/undecided — see conversation history for the research behind each.
- Image-count-per-chapter increase (currently exploring 2/chapter for older
  readers, 4/chapter for younger readers) — cost math worked out, no
  decision made yet on whether to build it.
- Batch-mode routing for interior illustrations — decided, not yet built.
- Non-ad growth channel: leaning toward a referral/word-of-mouth program
  leveraging current testers — sketched, not built.
- Manuscript rules #4/#5 (mentor humanizing crack; generalizing the
  magic-metaphor principle) — discussed, not drafted.

## Pre-launch checklist (before real traffic)

- [ ] Flip Stripe to a live (`sk_live_...`) key and stop sharing the test
      card — do this together with the Lulu flip, not separately
- [ ] Flip `LULU_SANDBOX` to `false` and redeploy
- [ ] Re-register Lulu's webhook against live
- [ ] Confirm Lulu account has a valid payment method on file
- [ ] Confirm `ANTHROPIC_API_KEY` has no silent expiration date set (the
      previous key expired unnoticed and took down story generation
      sitewide until a tester happened to report it)
- [ ] Decide how much manual review scales — the admin-approval gate
      requires a human to click every single order; this doesn't scale to
      high volume as-is
