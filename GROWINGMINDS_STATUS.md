# Growing Minds — Project Status

_Last updated: 2026-09-03. Reconstructed from the git repo after a Claude Code
cloud chat hit its context limit and could not be continued. Anything about the
chat's own reasoning/decisions is NOT captured here — only what is visible in
git and the code._

## What this is

Growing Minds — personalized children's story books. A customer fills out an
intake form about their child, gets a short AI-written cliffhanger preview, pays
$22, and receives a full personalized illustrated story as a PDF plus a
print-on-demand book shipped via Lulu.

- **Hosting:** Vercel (`vercel --prod`), domain `growingminds.io`
- **Story text:** Claude (`@anthropic-ai/sdk`)
- **Illustrations:** OpenAI `gpt-image-1` (production path); Gemini
  "Nano Banana Pro" (`gemini-3-pro-image`) is a prototype for
  character-consistent illustrations in `api/test-character-image.js`
- **Payments:** Stripe (preview checkout, main $22 checkout, upgrade checkout)
- **Print fulfillment:** Lulu Direct
- **Background jobs:** Inngest (`api/inngest.js`, `inngest.js`)
- **Storage:** Vercel Blob (images/PDFs) + Upstash Redis (story tokens, drafts)
- **Lead capture / archive:** Airtable
- **Email:** Resend
- **PDF:** pdfshift (HTML→PDF) + `pdf-lib` + `satori`/`@resvg/resvg-js`

See `DEPLOYMENT.md` for the deploy runbook and API request/response shapes.
See `env.example.txt` for the full list of required environment variables.

## Where the code is

| Branch | State |
|---|---|
| `origin/main` | Last commit `e7d734c` (Aug 30), PRs #1–#10 merged. Newest: remove recursive `vercel dev` script. |
| `origin/claude/git-file-read-write-banjdn` | **Active WIP, 9 commits ahead of main.** Newest `7111006` (Sep 3): point Gemini prototype at Nano Banana Pro (`gemini-3-pro-image`). This is the branch the dead cloud chat was working on. |
| `origin/claude/nano-banana-pro-model` | Small variant — 1 commit ahead of main (`de814b1`), only `api/test-character-image.js`. |
| other `claude/*` branches | Older superseded work (cover art, outline tokens, Airtable errors) — most is folded into `git-file-read-write-banjdn`. |

### Commits on `claude/git-file-read-write-banjdn` not yet in main
- Point Gemini prototype at Nano Banana Pro (`gemini-3-pro-image`)
- Remove recursive `"dev": "vercel dev"` script from package.json
- Add Gemini 2.5 Flash Image prototype for character-consistent illustrations
- Increase outline generation token budget to prevent JSON truncation
- Surface real Airtable failures instead of silently swallowing them
- Steer cover art / scene descriptions toward heroic agency, not passive cuteness
- Make cover art full-bleed with title overlaid on a dark scrim
- Fix interior PDF to match Lulu print spec (was Letter-sized)
- Steer preview cover art toward glossy Pixar-style rendering

## Open questions / decisions to make

- **Disposition of `claude/git-file-read-write-banjdn`:** review it, open a PR,
  and merge to `main` — or cherry-pick the pieces you want. It has accumulated 9
  commits without landing.
- **Nano Banana Pro rollout:** `gemini-3-pro-image` currently lives only in the
  `api/test-character-image.js` prototype (gated by `ADMIN_WEBHOOK_SECRET`). It
  is NOT wired into the real illustration path (`generate-preview` / Inngest).
  Decision needed: does it replace `gpt-image-1`, and for which steps?
- Whether there is an open PR on GitHub for this branch (couldn't check — no
  `gh` CLI installed locally).

## Pre-launch TODO (from DEPLOYMENT.md — verify against current code)

- [ ] Wire email provider in the webhook delivery path
- [ ] Confirm PDF storage (Vercel Blob) in the webhook path
- [ ] Upload a test PDF to Lulu, confirm `pod_package_id`
- [ ] End-to-end test with Stripe test mode
- [ ] Confirm intake form → `/api/generate-preview` and preview → `/api/create-checkout` wiring
- [ ] Confirmation page

## Security note

The git remote URL had a GitHub personal access token embedded in plaintext
(`https://pdibari1:ghp_...@github.com/...`). Revoke it at
github.com/settings/tokens and set the remote to the plain HTTPS URL with a
credential helper.
