// api/blog-post.js — individual blog post page, served at /blog/:slug
// (see vercel.json rewrite: /blog/:slug -> /api/blog-post?slug=:slug)
const { getPost, escapeHtml, formatDate, renderHead, renderNav, renderFooter, SITE_URL } = require("./blog-lib");

module.exports = async function handler(req, res) {
  const slug = req.query.slug;
  const post = slug ? getPost(slug) : null;

  if (!post) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(404).send(`<!DOCTYPE html><html><head><title>Not found — Growing Minds</title></head><body style="font-family:sans-serif;text-align:center;padding:5rem 1rem;"><h1>Post not found</h1><p><a href="/blog">← Back to the blog</a></p></body></html>`);
  }

  const canonicalPath = `/blog/${post.slug}`;

  // BlogPosting schema for search/AI-search relevance — the whole point of
  // this feature. mainEntityOfPage ties the structured data to this exact URL.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt,
    datePublished: post.datePublished,
    dateModified: post.dateModified || post.datePublished,
    author: { "@type": "Organization", name: "Growing Minds" },
    publisher: {
      "@type": "Organization",
      name: "Growing Minds",
      logo: { "@type": "ImageObject", url: `${SITE_URL}/favicon.svg` },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": `${SITE_URL}${canonicalPath}` },
  };

  // Citing real sources is a brief requirement, not just a nice-to-have —
  // rendered plainly at the bottom, not hidden, so it's easy to spot-check.
  const sourcesHtml = Array.isArray(post.sources) && post.sources.length
    ? `
    <div style="margin-top:3rem;padding-top:1.5rem;border-top:1px solid rgba(45,106,79,0.15);">
      <div style="font-size:.8rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:.75rem;">Sources</div>
      <ul style="padding-left:1.2rem;font-size:.9rem;color:var(--muted);line-height:1.8;">
        ${post.sources.map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a></li>`).join("")}
      </ul>
    </div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
${renderHead({ title: `${post.title} — Growing Minds`, description: post.excerpt, canonicalPath, jsonLd })}
</head>
<body>
${renderNav()}
<main>
  <p style="margin-bottom:1.5rem;"><a href="/blog" style="color:var(--muted);font-size:.9rem;text-decoration:none;">← Blog</a></p>
  <div style="font-size:.85rem;color:var(--muted);margin-bottom:.75rem;">${formatDate(post.datePublished)}</div>
  <h1 style="font-family:'Fraunces',serif;font-size:2.1rem;line-height:1.25;margin-bottom:1.5rem;">${escapeHtml(post.title)}</h1>
  <div style="font-size:1.05rem;line-height:1.75;color:var(--text);">${post.body}</div>
  ${sourcesHtml}
  <div style="margin-top:3rem;padding:1.75rem;background:var(--green-pale);border-radius:16px;text-align:center;">
    <p style="font-weight:700;margin-bottom:.75rem;">Want a story written just for your child?</p>
    <a href="/intake-form" class="nav-cta" style="display:inline-block;">Start their story →</a>
  </div>
</main>
${renderFooter()}
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
};
