# Growing Minds — Backend Deployment Guide

## What's in this folder

| File | Purpose |
|------|---------|
| `api/generate-preview.js` | Generates the 180–220 word cliffhanger preview via Claude |
| `api/create-checkout.js`  | Creates a Stripe Checkout session for the $22 purchase |
| `api/webhook.js`          | Fires after payment — generates full story, creates PDF, emails customer, submits Lulu print order |
| `.env.example`            | All environment variables you need to set |
| `vercel.json`             | Vercel deployment config |

---

## Step-by-Step Deployment

### 1. Install Vercel CLI
```bash
npm install -g vercel
```

### 2. Clone / create your project folder
Put all these files in a folder called `growingminds`.
Also add your three HTML files (index.html, intake-form.html, story-preview.html) to the root.

### 3. Install dependencies
```bash
npm install
```

### 4. Set up environment variables
```bash
cp .env.example .env.local
# Then fill in your actual keys in .env.local
```

### 5. Deploy to Vercel
```bash
vercel        # first time — follow prompts, link to your account
vercel --prod # deploy to production
```

### 6. Add your domain
In Vercel Dashboard → your project → Settings → Domains
Add: `growingminds.io`
Then update your DNS at your domain registrar to point to Vercel.

### 7. Set environment variables in Vercel
Vercel Dashboard → your project → Settings → Environment Variables
Add every variable from `.env.example` with real values.

### 8. Set up Stripe Webhook
1. Go to Stripe Dashboard → Developers → Webhooks
2. Click "Add endpoint"
3. URL: `https://growingminds.io/api/webhook`
4. Events to listen for: `checkout.session.completed`
5. Copy the "Signing secret" → paste as `STRIPE_WEBHOOK_SECRET` in Vercel

### 9. Connect frontend to backend
Update `intake-form.html` — the submit function should POST to `/api/generate-preview`
Update `story-preview.html` — the buy button should POST to `/api/create-checkout`

---

## API Reference

### POST /api/generate-preview
**Request body:**
```json
{
  "name": "Mia",
  "age": "6",
  "gender": "girl",
  "hair": "Blonde",
  "eye": "Blue",
  "trait": "Brave",
  "favorite": "dinosaurs",
  "friend": "Biscuit",
  "city": "Austin",
  "region": "Texas",
  "milestone": "Starting kindergarten"
}
```
**Response:**
```json
{
  "preview": "The morning sun crept through...",
  "storyToken": "eyJuYW1lIjoi...",
  "storyId": "story_1234567890_abc123",
  "childName": "Mia"
}
```

### POST /api/create-checkout
**Request body:**
```json
{
  "storyToken": "eyJuYW1lIjoi...",
  "childName": "Mia",
  "storyId": "story_1234567890_abc123"
}
```
**Response:**
```json
{
  "checkoutUrl": "https://checkout.stripe.com/c/pay/..."
}
```

### POST /api/webhook (Stripe only)
Called automatically by Stripe after payment. Handles everything.

---

## Still TODO before launch

- [ ] Wire up email provider (Resend or SendGrid) in `webhook.js` → `sendDeliveryEmail()`
- [ ] Set up PDF storage (Vercel Blob recommended) in `webhook.js` → `storePDFAndGetLink()`
- [ ] Upload a test PDF to Lulu and get your `pod_package_id` confirmed
- [ ] Test full flow end-to-end with Stripe test mode
- [ ] Connect intake-form.html submit → `/api/generate-preview`
- [ ] Connect story-preview.html buy button → `/api/create-checkout`
- [ ] Build confirmation page (confirmation.html)
