// Fixture site with known, deliberate SEO defects, used to verify that the pro engine
// finds exactly what is planted here. Serves on :4951.
import { createServer } from "node:http";

const shell = (title, meta, body, extraHead = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>${meta ? `<meta name="description" content="${meta}">` : ""}${extraHead}
</head><body><nav><a href="/">Home</a> <a href="/services.html">Services</a> <a href="/about.html">About</a>
<a href="/contact.html">Contact</a> <a href="/noindex.html">Hidden</a> <a href="/missing.html">Dead link</a>
<a href="https://this-domain-should-not-resolve-xyzzy.example">Dead outbound</a></nav>${body}</body></html>`;

const filler = (n) => Array.from({ length: n }, (_, i) => `Sentence ${i} about roof repair, gutter work and siding in Astoria Queens for local homeowners.`).join(" ");

const PAGES = {
  "/": shell("Astoria Roofing: Roof Repair in Astoria, Queens",
    "Roof repair, gutters and siding in Astoria, Queens. Call for a free estimate today from a licensed local crew.",
    `<h1>Roof repair in Astoria</h1><p>Call <a href="tel:+17185550101">718-555-0101</a> or 718-555-0101.</p>
     <p>12 Ditmars Boulevard, Astoria, NY. Open Mon - Fri 8:00 am to 6:00 pm.</p>
     <img src="http://insecure.example.com/roof.jpg" alt="a roof"><img src="/photo.jpg">
     <p>${filler(30)}</p>`),
  "/services.html": shell("Astoria Roofing: Roof Repair in Astoria, Queens", "",
    `<h1>Services</h1><p>${filler(28)}</p><img src="/s1.jpg"><img src="/s2.jpg">`),
  "/about.html": shell("About", "About the company and the crew that does the work here.",
    `<p>We fix roofs.</p>`),
  "/contact.html": shell("Contact Astoria Roofing: Free Estimates in Queens NY",
    "Contact Astoria Roofing for a free estimate on roof repair, gutters or siding anywhere in Queens.",
    `<h1>Contact</h1><h1>Second headline</h1><form><input name="name"><button>Send</button></form>
     <iframe src="https://www.google.com/maps/embed?pb=1"></iframe><p>${filler(25)}</p>`),
  "/noindex.html": shell("Hidden page", "This page is deliberately noindexed.",
    `<h1>Hidden</h1><p>${filler(20)}</p>`, `<meta name="robots" content="noindex">`),
  "/orphan.html": shell("Orphan page nobody links to from anywhere on the site",
    "An orphan page: it is in the sitemap but no page links to it.",
    `<h1>Orphan</h1><p>${filler(22)}</p>`),
};

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${["/", "/services.html", "/about.html", "/contact.html", "/orphan.html"]
    .map(p => `<url><loc>http://localhost:4951${p}</loc></url>`).join("\n")}</urlset>`;

createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("User-agent: *\nDisallow: /private/\nSitemap: http://localhost:4951/sitemap.xml\n"); }
  if (path === "/sitemap.xml") { res.writeHead(200, { "content-type": "application/xml" }); return res.end(SITEMAP); }
  if (PAGES[path]) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PAGES[path]); }
  res.writeHead(404, { "content-type": "text/html" });
  res.end("<!doctype html><title>Not found</title><h1>404</h1>");
}).listen(4951, () => console.log("fixture on http://localhost:4951"));
