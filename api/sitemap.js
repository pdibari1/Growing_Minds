// api/sitemap.js — dynamic sitemap.xml at /sitemap.xml (see vercel.json
// rewrite). Lists the core public marketing pages plus every blog post, so
// a new post shows up here automatically on its next deploy with no
// separate sitemap-editing step.
const { loadPosts, SITE_URL } = require("./blog-lib");

const STATIC_PAGES = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/blog", changefreq: "daily", priority: "0.8" },
  { path: "/intake-form", changefreq: "monthly", priority: "0.7" },
  { path: "/privacy-policy", changefreq: "yearly", priority: "0.2" },
  { path: "/terms", changefreq: "yearly", priority: "0.2" },
  { path: "/returns", changefreq: "yearly", priority: "0.2" },
];

module.exports = async function handler(req, res) {
  const posts = loadPosts();

  const staticUrls = STATIC_PAGES.map((p) => `
  <url>
    <loc>${SITE_URL}${p.path}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join("");

  const postUrls = posts.map((p) => `
  <url>
    <loc>${SITE_URL}/blog/${p.slug}</loc>
    <lastmod>${p.dateModified || p.datePublished}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`).join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${staticUrls}${postUrls}
</urlset>`;

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  return res.status(200).send(xml);
};
