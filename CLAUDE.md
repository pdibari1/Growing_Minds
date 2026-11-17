# CLAUDE.md — Growing Minds

Personalized children's story books. Customer fills an intake form → AI-written
cliffhanger preview ($2.99) → orders the full 30-chapter book ($35). Physical
book delivery via Lulu print-on-demand is not yet wired into the live order
flow — see the Lulu print pipeline note in `GROWINGMINDS_STATUS.md`.

**Read `GROWINGMINDS_STATUS.md` first** for current state, active branch, and
open decisions.

## Stack

- Static HTML frontend (`index.html`, `intake-*.html`, `story-preview.html`,
  `confirmation.html`) + serverless functions in `api/`, deployed on Vercel.
- Story text: Claude (`@anthropic-ai/sdk`).
- Illustrations: Gemini `gemini-3-pro-image` ("Nano Banana Pro") in production,
  with reference-image conditioning for character consistency across a book's
  cover and interior scenes. `api/test-character-image.js` is a standalone
  admin diagnostic tool for one-off prompt/scene experiments, not the
  production path.
- Stripe (checkout), Lulu Direct (print, not yet wired into the live order
  flow), Inngest (background jobs), Vercel Blob + Upstash Redis (storage),
  Airtable (leads), Resend (email), pdfshift + pdf-lib + satori/resvg (PDF).

## Key files

| Path | Purpose |
|---|---|
| `api/generate-preview.js` | 180–220 word cliffhanger preview via Claude |
| `api/create-checkout.js` / `create-preview-checkout.js` / `create-upgrade-checkout.js` | Stripe Checkout sessions |
| `api/webhook.js` | Verifies Stripe, queues the Inngest job, sends purchase notifications |
| `api/inngest.js` | Story/illustration generation, PDF assembly, admin notifications |
| `api/lulu*.js` | Lulu print submission + webhook + job polling (admin-only test path today) |
| `api/test-character-image.js` | Admin diagnostic tool for Gemini prompt/scene experiments (gated by `ADMIN_WEBHOOK_SECRET`) |
| `api/recover-dropped-order.js` | Admin tool to manually re-queue a paid order whose storyToken expired out of Redis before Inngest ever saw it (gated by `ADMIN_WEBHOOK_SECRET`) |
| `api/recover-missing-illustrations.js` | Admin tool to regenerate just the still-missing images for an order whose illustration step partially failed (e.g. Gemini billing ran out mid-batch), and rebuild the full PDF — without re-running outline/chapter generation (gated by `ADMIN_WEBHOOK_SECRET`) |
| `prelaunch.js` + `api/waitlist.js` | Pre-launch switch, UI side only: while on, homepage CTAs open a waitlist signup and intake pages redirect there (`?tester=1` bypasses, sets a `gm_tester` cookie + localStorage); waitlist saved in Redis, CSV export gated by `ADMIN_WEBHOOK_SECRET` |
| `api/prelaunch-lib.js` | Pre-launch switch, server side — the actual enforcement. Checked by `generate-preview.js`/`create-checkout.js`/`create-preview-checkout.js`/`create-upgrade-checkout.js` so a direct request can't skip the waitlist the way a UI-only redirect could. Driven by the `PRELAUNCH` env var, a separate flag from the `PRELAUNCH` constant in `prelaunch.js` — both must be flipped at launch |
| `DEPLOYMENT.md` | Deploy runbook + API request/response shapes |
| `env.example.txt` | All required environment variables |

## Conventions

- Cloud Claude Code work lands on `claude/*` branches, then a PR to `main`.
- Env vars live in `.env.local` locally and Vercel project settings in prod.
- Deploy: `npm run deploy` (`vercel --prod`).
- Do not commit `.env.local` or `.DS_Store`.
- Commit message trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`

## Illustration art direction (established in merged PRs)

Cover art: full-bleed, title on a dark scrim, glossy Pixar-style rendering,
heroic agency rather than passive cuteness. Don't repeat the cover illustration
inside chapter 1.
