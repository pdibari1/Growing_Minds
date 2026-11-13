# Blog posts

Each approved article is one JSON file in this directory. The blog index
(`/blog`), each post's page (`/blog/<slug>`), and `/sitemap.xml` all read
these files directly at request time (`api/blog-lib.js`) — drop a new file
here, deploy, and it's live. No database, no separate publish step.

Filename doesn't matter (only `.json` files are read) — `<slug>.json` is a
reasonable convention, e.g. `starting-school-separation-anxiety.json`.

## Schema

```json
{
  "slug": "starting-school-separation-anxiety",
  "title": "What Actually Helps at Drop-Off (It's Not What You Think)",
  "datePublished": "2026-11-17",
  "dateModified": "2026-11-17",
  "excerpt": "One or two sentences — shown on the blog index and used as the meta description / BlogPosting schema description.",
  "body": "<p>Full article body as HTML. One or more paragraphs, <h2> subheadings if useful, no inline styles needed.</p>",
  "sources": [
    { "title": "Name of the source", "url": "https://..." }
  ]
}
```

Required fields: `slug`, `title`, `datePublished`. A post missing any of
these is silently skipped (logged, not shown) rather than breaking the
whole blog index if one file is malformed.

`body` is raw HTML dropped directly into the page — no sanitization, since
these are trusted, admin-reviewed drafts, not user input. `slug` becomes
the URL (`/blog/<slug>`) — keep it URL-safe (lowercase, hyphens, no spaces).

## What this does NOT do yet

There's no admin UI to turn a drafted article into one of these files —
that's the "read, approve, and post" tool, a separate, later piece of work.
For now, turning an approved draft into a live post means creating a file
here by hand (or asking Claude Code to do it) and deploying.
