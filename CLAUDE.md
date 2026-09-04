# CLAUDE.md — Growing Minds

Personalized children's story books. Customer fills an intake form → AI-written
cliffhanger preview → pays $22 → receives a full personalized illustrated story
(PDF) + a print-on-demand book via Lulu.

**Read `GROWINGMINDS_STATUS.md` first** for current state, active branch, and
open decisions.

## Stack

- Static HTML frontend (`index.html`, `intake-*.html`, `story-preview.html`,
  `confirmation.html`) + serverless functions in `api/`, deployed on Vercel.
- Story text: Claude (`@anthropic-ai/sdk`).
- Illustrations: OpenAI `gpt-image-1` in production; Gemini `gemini-3-pro-image`
  ("Nano Banana Pro") is a prototype in `api/test-character-image.js`.
- Stripe (checkout), Lulu Direct (print), Inngest (background jobs),
  Vercel Blob + Upstash Redis (storage), Airtable (leads), Resend (email),
  pdfshift + pdf-lib + satori/resvg (PDF).

## Key files

| Path | Purpose |
|---|---|
| `api/generate-preview.js` | 180–220 word cliffhanger preview via Claude |
| `api/create-checkout.js` / `create-preview-checkout.js` / `create-upgrade-checkout.js` | Stripe Checkout sessions |
| `api/webhook.js` | Post-payment: full story, PDF, email, Lulu order |
| `api/inngest.js`, `inngest.js` | Background job orchestration |
| `api/lulu*.js` | Lulu print submission + webhook + job polling |
| `api/test-character-image.js` | Nano Banana Pro illustration prototype (gated by `ADMIN_WEBHOOK_SECRET`) |
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
