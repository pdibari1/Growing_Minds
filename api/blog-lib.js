// api/blog-lib.js — shared helpers for the blog (api/blog.js, api/blog-post.js,
// api/sitemap.js). Not a route itself — same pattern as api/lulu.js, a plain
// module other api/*.js files require(), not a request handler.
//
// Posts are static JSON files in blog-posts/, committed to the repo rather
// than stored in Redis — this is durable editorial content, not ephemeral
// order data, and git gives it real history/backup for free. See
// blog-posts/README.md for the exact schema a new post file needs.
const fs = require("fs");
const path = require("path");

const POSTS_DIR = path.join(__dirname, "..", "blog-posts");
const SITE_URL = "https://www.growingminds.io";

function loadPosts() {
  let files;
  try {
    files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith(".json"));
  } catch (e) {
    return [];
  }
  const posts = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(POSTS_DIR, file), "utf8");
      const post = JSON.parse(raw);
      if (post.slug && post.title && post.datePublished) posts.push(post);
      else console.error(`Skipping ${file}: missing slug/title/datePublished`);
    } catch (e) {
      console.error(`Failed to parse blog post ${file}: ${e.message}`);
    }
  }
  posts.sort((a, b) => new Date(b.datePublished) - new Date(a.datePublished));
  return posts;
}

function getPost(slug) {
  return loadPosts().find((p) => p.slug === slug) || null;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatDate(iso) {
  try {
    return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
    });
  } catch (e) {
    return iso;
  }
}

// Shared <head> — matches index.html's fonts/palette so blog pages don't
// look like a separate site bolted on. jsonLd (BlogPosting schema) is only
// passed by api/blog-post.js, for individual posts.
function renderHead({ title, description, canonicalPath, jsonLd }) {
  return `
  <link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}"/>
  <link rel="canonical" href="${SITE_URL}${canonicalPath}"/>
  <meta property="og:type" content="article"/>
  <meta property="og:title" content="${escapeHtml(title)}"/>
  <meta property="og:description" content="${escapeHtml(description)}"/>
  <meta property="og:url" content="${SITE_URL}${canonicalPath}"/>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,600;0,9..144,700;1,9..144,300;1,9..144,600&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet"/>
  ${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ""}
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-P6FLSR57GV"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag("js", new Date());
    gtag("config", "G-P6FLSR57GV");
  </script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --green: #2d6a4f; --green-light: #52b788; --green-pale: #d8f3dc;
      --yellow: #f9c74f; --cream: #fefae0; --text: #1a1a2e; --muted: #6b7280; --white: #ffffff;
    }
    html { scroll-behavior: smooth; }
    body { font-family: 'Nunito', sans-serif; background: var(--cream); color: var(--text); }
    a { color: var(--green); }
    nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1rem 2.5rem; background: rgba(254,250,224,0.92);
      border-bottom: 1px solid rgba(45,106,79,0.1);
    }
    .nav-logo {
      font-family: 'Fraunces', serif; font-weight: 700; font-size: 1.5rem;
      color: var(--green); text-decoration: none;
    }
    .nav-cta {
      background: var(--green); color: var(--white); border: none; border-radius: 50px;
      padding: .6rem 1.5rem; font-weight: 700; font-size: .95rem; text-decoration: none;
    }
    .nav-cta:hover { background: var(--green-light); }
    main { max-width: 760px; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
    main p { margin-bottom: 1.25rem; }
    main h2 { font-family: 'Fraunces', serif; font-size: 1.4rem; margin: 2rem 0 1rem; }
    main ul, main ol { margin: 0 0 1.25rem 1.3rem; }
    footer { text-align: center; padding: 3rem 1.5rem; color: var(--muted); font-size: .9rem; }
    footer a { color: var(--green-light); text-decoration: none; }
  </style>`;
}

function renderNav() {
  return `
  <nav>
    <a class="nav-logo" href="/">🌱 Growing Minds</a>
    <a class="nav-cta" href="/intake-form">Start their story →</a>
  </nav>`;
}

function renderFooter() {
  return `
  <footer>
    <div style="font-family:'Fraunces',serif;font-weight:700;color:var(--green);margin-bottom:.5rem;">🌱 Growing Minds</div>
    <p>Personalized story books for curious kids, ages 3–13.<br/>
    <a href="mailto:help@growingminds.io">help@growingminds.io</a></p>
    <p style="margin-top:1rem;font-size:.8rem;">© 2026 Growing Minds LLC. All rights reserved. · <a href="/privacy-policy" style="color:inherit;">Privacy Policy</a> · <a href="/terms" style="color:inherit;">Terms of Service</a></p>
  </footer>`;
}

module.exports = {
  loadPosts, getPost, escapeHtml, formatDate,
  renderHead, renderNav, renderFooter,
  SITE_URL, POSTS_DIR,
};
