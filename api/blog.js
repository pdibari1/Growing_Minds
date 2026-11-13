// api/blog.js — blog index page, served at /blog (see vercel.json rewrite)
const { loadPosts, escapeHtml, formatDate, renderHead, renderNav, renderFooter } = require("./blog-lib");

module.exports = async function handler(req, res) {
  const posts = loadPosts();

  const title = "Blog — Growing Minds";
  const description = "Parent-to-parent guidance on childhood milestones, big feelings, and the moments that matter — from the team behind Growing Minds personalized story books.";

  const cardsHtml = posts.length
    ? posts.map((p) => `
    <a href="/blog/${escapeHtml(p.slug)}" style="display:block;background:#fff;border:1px solid rgba(45,106,79,0.12);border-radius:16px;padding:1.75rem;margin-bottom:1.25rem;text-decoration:none;color:inherit;">
      <div style="font-size:.8rem;color:var(--muted);margin-bottom:.4rem;">${formatDate(p.datePublished)}</div>
      <h2 style="font-family:'Fraunces',serif;font-size:1.35rem;color:var(--text);margin-bottom:.5rem;">${escapeHtml(p.title)}</h2>
      <p style="color:var(--muted);font-size:.95rem;line-height:1.6;margin:0;">${escapeHtml(p.excerpt)}</p>
    </a>`).join("")
    : `<p style="color:var(--muted);text-align:center;padding:3rem 0;">New articles are on the way — check back soon.</p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
${renderHead({ title, description, canonicalPath: "/blog" })}
</head>
<body>
${renderNav()}
<main>
  <div style="font-size:.8rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--green);margin-bottom:.5rem;">From Growing Minds</div>
  <h1 style="font-family:'Fraunces',serif;font-size:2.2rem;margin-bottom:.75rem;">Blog</h1>
  <p style="color:var(--muted);margin-bottom:2.5rem;">${escapeHtml(description)}</p>
  ${cardsHtml}
</main>
${renderFooter()}
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
};
