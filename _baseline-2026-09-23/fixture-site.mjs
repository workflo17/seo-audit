// Fixture site with known, deliberate defects, used to verify that the pro engine finds
// exactly what is planted here and nothing else. Serves on :4951.
//   node fixture-site.mjs            normal: unknown paths return a real 404
//   SOFT404=1 node fixture-site.mjs  unknown paths return 200 (tests the link-check blindness path)
// Planted: duplicate title (/ and /services), missing meta (/services), no H1 and thin copy
// (/about), two H1s + unlabelled form + incomplete self-serving schema (/contact), a near
// duplicate pair (/services and /services-copy), noindex via meta (/noindex), via googlebot
// meta with reversed attributes (/hidden-google), via X-Robots-Tag header (/hidden-header),
// an orphan in the sitemap only (/orphan), placeholder text (/placeholder), an off-site
// canonical (/canon-offsite), a two-hop redirect chain linked from home (/old), a page four
// clicks deep (/deep4), a JavaScript-only page (/app.html), three broken images and one
// insecure one, a broken og:image, a dead internal link and a dead outbound link, robots.txt
// with a stacked Googlebot group and an Allow exception, a sitemap with CDATA locs, one dead
// URL, one noindexed URL and one off-host URL.
import { createServer } from "node:http";

const SOFT404 = process.env.SOFT404 === "1";

const shell = (title, meta, body, { head = "", lang = "" } = {}) => `<!doctype html><html${lang ? ` lang="${lang}"` : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>${meta ? `<meta name="description" content="${meta}">` : ""}${head}
</head><body><header><nav><a href="/">Home</a> <a href="/services.html">Services</a> <a href="/about.html">About</a>
<a href="/contact.html">Contact</a> <a href="/noindex.html">Hidden</a> <a href="/hidden-google.html">Hidden two</a>
<a href="/hidden-header.html">Hidden three</a> <a href="/placeholder.html">Coming soon</a> <a href="/canon-offsite.html">Partners</a>
<a href="/app.html">Gallery</a> <a href="/deep1.html">Areas</a> <a href="/old">Old services link</a>
<a href="/private/public-page.html">Warranty</a> <a href="/private/secret.html">Staff</a>
<a href="/missing.html">Dead link</a> <a href="https://this-domain-should-not-resolve-xyzzy.example">Dead outbound</a></nav></header>
<main>${body}</main>
<footer><p>Astoria Roofing, 12 Ditmars Boulevard, Astoria, NY 11105. Open Mon to Fri 8:00 am to 6:00 pm.</p></footer></body></html>`;

const HOME = `<h1>Roof repair in Astoria</h1>
<p>Call <a href="tel:+17185550101">718-555-0101</a> or 718-555-0101 for a same-week visit.</p>
<img src="http://insecure.example.com/roof.jpg" alt="a finished roof"><img src="/photo.jpg">
<p>We have replaced and repaired roofs on the row houses and two-family homes of Astoria and Long Island City since 2009. Most calls start the same way: a stain on a bedroom ceiling after a storm, or a gutter that has started pulling away from the fascia. We come out, get on the roof, and tell you what we found with photos before we quote anything.</p>
<p>Flat roofs are most of our work. Modified bitumen, EPDM rubber and cool white coatings each have a place, and we will tell you which one suits the building rather than the one we happen to have on the truck. For pitched roofs we install architectural asphalt shingles and standing seam metal.</p>
<p>Every job is cleaned up the same day, the debris goes in our truck rather than your bin, and the invoice matches the estimate unless you asked for something extra.</p>`;

const SERVICES = `<h1>Services</h1>
<img src="/s1.jpg"><img src="/s2.jpg" width="640" height="420" alt="crew installing shingles">
<p>Roof repair covers the leaks, flashing failures and storm damage that do not need a full replacement. We patch modified bitumen, reseal seams on rubber roofs, replace cracked slate and rebuild chimney flashing that has lifted.</p>
<p>Roof replacement is for roofs past saving. We strip to the deck, replace any soft plywood, install ice and water shield at the edges, and lay the new system with a manufacturer warranty registered in your name.</p>
<p>Gutters and leaders are cleaned, repaired or replaced in aluminum or copper. Downspout extensions keep water away from the foundation, which is where most basement dampness in Queens actually starts.</p>
<p>Skylights, vents and drains are sealed or replaced as part of any job where we find them failing.</p>
<p><a href="/services-copy.html">See the printable version of this page</a>.</p>`;

const ABOUT = `<p>We fix roofs.</p>`;

const CONTACT = `<h1>Contact</h1><h1>Get a free estimate</h1>
<form action="/quote" method="post"><input name="name" placeholder="Name"><input name="phone" placeholder="Phone"><textarea name="job"></textarea><button>Send</button></form>
<iframe src="https://www.google.com/maps/embed?pb=1" title="map"></iframe>
<p>Reviews: <a href="https://www.yelp.com/biz/astoria-roofing">read us on Yelp</a>.</p>
<p>Estimates are free and take about forty minutes. Bring us the insurance adjuster's report if you have one and we will match the scope line by line so nothing gets missed or double counted.</p>
<p>For emergencies after a storm we keep two tarps on every truck and can secure most roofs the same day, then return for the permanent repair once the weather clears.</p>`;
const CONTACT_HEAD = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"RoofingContractor","name":"Astoria Roofing","telephone":"718-555-0101","aggregateRating":{"@type":"AggregateRating","ratingValue":"4.9","reviewCount":"41"}}</script>
<meta property="og:title" content="Contact Astoria Roofing"><meta property="og:image" content="/og.png">`;

const DEEP = n => `<h1>Service area ${n}</h1><p>We work throughout western Queens. This page covers area number ${n}: typical roof types there, the permits the borough asks for, and how long a repair usually takes once the materials are on site. ${n < 4 ? `<a href="/deep${n + 1}.html">Next area</a>` : "This is the last area page."}</p>`;

const APP = `<div id="app"></div><script>
document.getElementById("app").innerHTML = "<h1>Project gallery</h1>" +
  "<p>Forty roofs from the last three seasons, each with a before and after photo, the material used and what the homeowner first called about. Flat roof coatings in Ditmars, a full tear-off on 31st Avenue, copper gutters on a landmarked block in Long Island City, and a standing seam metal roof that replaced three layers of asphalt. Every project here was completed by our own crew, not a subcontractor, and every one carries the warranty we registered on the day the job closed.</p>" +
  "<p>Browse by neighbourhood or by roof type, or <a href='/app-only.html'>see the most recent ten</a>.</p>";
</script>`;

const PAGES = {
  "/": [shell("Astoria Roofing: Roof Repair in Astoria, Queens", "Roof repair, gutters and siding in Astoria, Queens. Call for a free estimate today from a licensed local crew.", HOME,
    { lang: "en", head: `<meta property="og:title" content="Astoria Roofing"><meta property="og:image" content="/og.png">` })],
  "/services.html": [shell("Astoria Roofing: Roof Repair in Astoria, Queens", "", SERVICES)],
  "/services-copy.html": [shell("Our Services in Astoria", "Roof repair, replacement, gutters and skylights for Astoria homes.", SERVICES)],
  "/about.html": [shell("About", "About the company and the crew that does the work here.", ABOUT)],
  "/contact.html": [shell("Contact Astoria Roofing: Free Estimates in Queens NY", "Contact Astoria Roofing for a free estimate on roof repair, gutters or siding anywhere in Queens.", CONTACT, { head: CONTACT_HEAD })],
  "/noindex.html": [shell("Hidden page", "This page is deliberately noindexed.", `<h1>Hidden</h1><p>Internal notes about pricing for the crew. Not for search engines, which is exactly what the tag says.</p>`, { head: `<meta name="robots" content="noindex">` })],
  "/hidden-google.html": [shell("Hidden from Google only", "Noindex through a googlebot meta with reversed attributes.", `<h1>Google cannot index this</h1><p>Other engines can. The meta tag names googlebot and puts content before name, which naive parsers miss.</p>`, { head: `<meta content="noindex, nofollow" name="googlebot">` })],
  "/hidden-header.html": [shell("Hidden by a header", "Nothing in the source reveals this one.", `<h1>Hidden by the server</h1><p>The X-Robots-Tag response header says noindex. The HTML looks completely normal.</p>`), { "x-robots-tag": "noindex" }],
  "/orphan.html": [shell("Orphan page nobody links to from anywhere on the site", "An orphan page: it is in the sitemap but no page links to it.", `<h1>Orphan</h1><p>Gutter guards and leaf screens: what they cost, which ones clog anyway, and when they are worth fitting on a Queens row house.</p>`)],
  "/placeholder.html": [shell("Coming soon", "A page the template never finished.", `<h1>Coming soon</h1><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Call us today at 555-555-5555. This section is under construction.</p>`)],
  "/canon-offsite.html": [shell("Our partners", "Suppliers and partners we work with.", `<h1>Partners</h1><p>We buy membrane from two regional suppliers and send copper work to a fabricator in Maspeth who has done it for thirty years.</p>`, { head: `<link rel="canonical" href="https://other-site.example/partners">` })],
  "/deep1.html": [shell("Service area 1", "Area page one.", DEEP(1))],
  "/deep2.html": [shell("Service area 2", "Area page two.", DEEP(2))],
  "/deep3.html": [shell("Service area 3", "Area page three.", DEEP(3))],
  "/deep4.html": [shell("Service area 4", "Area page four.", DEEP(4))],
  "/app.html": [shell("Project gallery", "Forty recent roofs with before and after photos.", APP)],
  "/app-only.html": [shell("Ten most recent projects", "The ten roofs we finished most recently.", `<h1>Recent projects</h1><p>Ten roofs, ten photos, ten short notes on what the call was about and what it took. Reachable only through the gallery, which is built in the browser.</p>`)],
  "/private/public-page.html": [shell("Warranty terms", "What the workmanship warranty covers.", `<h1>Warranty</h1><p>Ten years on workmanship, manufacturer terms on materials, transferable once to a new owner. Allowed in robots.txt by an explicit Allow inside a disallowed folder.</p>`)],
  "/private/secret.html": [shell("Staff schedule", "Internal.", `<h1>Staff</h1><p>Should never be crawled: robots.txt disallows /private/ and nothing allows this one.</p>`)],
};

const ROBOTS = `User-agent: Googlebot
User-agent: Bingbot
Disallow: /private/
Allow: /private/public-page.html

User-agent: *
Disallow: /tmp/
Sitemap: http://localhost:4951/sitemap.xml
`;

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${["/", "/services.html", "/services-copy.html", "/about.html", "/contact.html", "/orphan.html", "/noindex.html", "/gone.html"]
    .map(p => `<url><loc><![CDATA[http://localhost:4951${p}]]></loc><lastmod>2026-08-01</lastmod></url>`).join("\n")}
<url><loc>https://other-host.example/not-ours.html</loc><lastmod>not-a-date</lastmod></url>
</urlset>`;

createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(ROBOTS); }
  if (path === "/sitemap.xml") { res.writeHead(200, { "content-type": "application/xml" }); return res.end(SITEMAP); }
  if (path === "/old") { res.writeHead(301, { location: "/old2" }); return res.end(); }
  if (path === "/old2") { res.writeHead(301, { location: "/services.html" }); return res.end(); }
  const page = PAGES[path];
  if (page) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(page[1] || {}) }); return res.end(page[0]); }
  if (SOFT404) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><title>Not found</title><h1>Page not found</h1><p>Soft 404: the server says 200.</p>"); }
  res.writeHead(404, { "content-type": "text/html" });
  res.end("<!doctype html><title>Not found</title><h1>404</h1>");
}).listen(4951, () => console.log("fixture on http://localhost:4951" + (SOFT404 ? " (soft-404 mode)" : "")));
