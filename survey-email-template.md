# Survey Email Template
**Send:** 48 hours after preview delivery
**From:** hello@growingminds.io (or your personal name)
**Subject line options (A/B test these):**
- `Quick question about [ChildName]'s story 📖`
- `Did [ChildName] love it? (2 min survey inside)`
- `Real talk — how did we do?`

---

## Email Body

Hi [ParentFirstName],

It's been a couple of days since [ChildName]'s story landed in your inbox — I hope you got a chance to read it together.

I'm the person behind Growing Minds, and I read every story before it goes out. I'd love to know honestly how it went.

**It takes about 2 minutes:**
👉 [Share my feedback →](https://www.growingminds.io/survey?sid=STORYID&name=CHILDNAME&em=EMAIL)

I'm asking about three things:
- Whether the story actually felt like *your* child
- What [ChildName]'s reaction was (this is the best part of my job to read)
- Anything that wasn't quite right

If something was off — a wrong detail, a name that didn't show up, an image that didn't match — I want to know. That's how we get better.

Thank you for trusting us with [ChildName]'s story.

[Your name]
Growing Minds

---

*You're receiving this because you ordered a personalized story at growingminds.io.*
*[Unsubscribe](https://www.growingminds.io/unsubscribe?em=EMAIL)*

---

## Delivery Strategy

| Timing | Action |
|--------|--------|
| T+0 | Preview delivered (existing flow) |
| T+48h | Send survey email (this template) |
| T+9d | One follow-up if no response: "Still have 2 minutes?" — same link |
| T+14d | No third email. Move on. |

## Personalization via URL params

The survey link encodes the story context so the page personalizes automatically:

```
https://www.growingminds.io/survey?sid={storyId}&name={childName}&em={parentEmail}
```

Wire this into the `sendPreviewEmail` flow in inngest.js — add a delayed Inngest step that fires 48 hours after preview delivery:

```javascript
await step.sleep("wait-for-survey-window", "48h");

await step.run("send-survey-email", async () => {
  const surveyUrl = `https://www.growingminds.io/survey?sid=${storyId}&name=${encodeURIComponent(childName)}&em=${encodeURIComponent(customerEmail)}`;
  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || 'Growing Minds <hello@growingminds.io>',
    to: customerEmail,
    subject: `Quick question about ${childName}'s story 📖`,
    html: buildSurveyEmailHtml(childName, surveyUrl) // build your HTML here
  });
});
```

## What to Track

Once responses are coming in, look for:
- **NPS < 7 + "anythingWrong" filled** → personal follow-up email from you within 24h
- **childReaction** field → paste the best ones straight into your homepage as testimonials
- **upgradeReasons: "price"** appearing frequently → test a lower upgrade price
- **upgradeReasons: "physical"** → signal to add a print option
- **personalization rating < 3** → review that specific storyId and find the root cause
