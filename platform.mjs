// Which site builder a page comes from, read from its own markup and headers, so each fix
// can say where the setting lives (Yoast's box, Wix's SEO basics, Shopify's search engine
// listing) instead of describing the change in the abstract. Zero dependencies.
//   node platform.mjs --selftest

const has = (re, s) => re.test(String(s || ""));

// html: the homepage markup. headers: response headers, lower-cased keys (fetch gives these).
export function detectPlatform(html, headers = {}) {
  const h = String(html || "");
  const hd = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  let name = null;
  if (hd["x-shopid"] || hd["x-shopify-stage"] || has(/cdn\.shopify\.com|Shopify\.theme\b|shopify-section/i, h)) name = "shopify";
  else if (hd["x-wix-request-id"] || /pepyaka/i.test(hd.server || "") || has(/static\.wixstatic\.com|<meta[^>]+generator[^>]+Wix\.com/i, h)) name = "wix";
  else if (has(/\/wp-content\/|\/wp-includes\/|<meta[^>]+generator[^>]+WordPress/i, h)) name = "wordpress";
  else if (has(/static1\.squarespace\.com|<!-- This is Squarespace/i, h)) name = "squarespace";
  else if (has(/data-wf-site=|assets\.website-files\.com|webflow\.js/i, h)) name = "webflow";
  let seoPlugin = null, builder = null;
  if (name === "wordpress") {
    if (has(/Yoast SEO|yoast-schema-graph/i, h)) seoPlugin = "yoast";
    else if (has(/Rank Math|rank-math/i, h)) seoPlugin = "rankmath";
    else if (has(/All in One SEO|aioseo/i, h)) seoPlugin = "aioseo";
    if (has(/elementor/i, h)) builder = "elementor";
    else if (has(/et_pb_|Divi/i, h)) builder = "divi";
  }
  // Wix, Shopify and Squarespace count visits themselves, so a site with no Google tag
  // still has numbers somewhere; the finding says so instead of calling it unmeasured.
  const nativeAnalytics = name === "wix" || name === "squarespace" || (name === "shopify" && has(/ShopifyAnalytics|trekkie/i, h));
  const label = { shopify: "Shopify", wix: "Wix", wordpress: "WordPress", squarespace: "Squarespace", webflow: "Webflow" }[name] || null;
  const pluginLabel = { yoast: "Yoast SEO", rankmath: "Rank Math", aioseo: "All in One SEO" }[seoPlugin] || null;
  return { name, label, seoPlugin, pluginLabel, builder, nativeAnalytics };
}

// Where each kind of fix is made, per platform. Paths name what the owner clicks; where a
// menu moves between versions the text points at the admin search instead of a path.
const TIPS = {
  titles: {
    yoast: "In WordPress, open the page and edit the SEO title in the Yoast SEO box under the editor.",
    rankmath: "In WordPress, open the page, click the Rank Math icon and use Edit Snippet.",
    wordpress: "WordPress has no title field of its own; install Yoast SEO or Rank Math and each page gets one.",
    wix: "In Wix: Pages & Menu, the page's three-dot menu, SEO basics, Title tag.",
    shopify: "In Shopify: open the product, page or collection, scroll to Search engine listing, click Edit, change the page title.",
    squarespace: "In Squarespace: the page's settings, SEO tab, SEO title.",
    webflow: "In Webflow: page settings, SEO settings, Title tag.",
  },
  meta: {
    yoast: "In WordPress, open the page and fill in the meta description in the Yoast SEO box.",
    rankmath: "In WordPress, open the page, click the Rank Math icon, Edit Snippet, description.",
    wordpress: "Install Yoast SEO or Rank Math to get a description field on every page.",
    wix: "In Wix: Pages & Menu, the page's three-dot menu, SEO basics, Meta description.",
    shopify: "In Shopify: Search engine listing, Edit, Meta description, on each product, page and collection.",
    squarespace: "In Squarespace: the page's settings, SEO tab, SEO description.",
    webflow: "In Webflow: page settings, SEO settings, Meta description.",
  },
  hide: {
    yoast: "In Yoast: Settings, Content types, switch off \"Show in search results\" for template and dashboard types. Delete leftovers such as Sample Page, or set them to noindex in their Yoast box.",
    rankmath: "In Rank Math: Titles & Meta, choose the post type, set Robots Meta to No Index. Delete leftovers such as Sample Page.",
    wordpress: "Delete leftover pages (Sample Page, duplicates of the homepage). An SEO plugin can keep template post types out of the sitemap.",
    wix: "In Wix: Pages & Menu, the page's three-dot menu, SEO basics, switch off \"Let search engines index this page\", or delete the page.",
    shopify: "In Shopify: delete or unpublish the duplicate under Online Store, Pages. Store policies belong under Settings, Policies, not as copies in Pages.",
    squarespace: "In Squarespace: the page's settings, SEO tab, \"Hide page from search results\", or delete it.",
    webflow: "In Webflow: page settings, turn on \"Exclude from site search\" and remove it from the sitemap, or delete it.",
  },
  redirects: {
    rankmath: "In Rank Math: switch on the Redirections module (Rank Math, Dashboard), then Rank Math, Redirections, Add New.",
    yoast: "In WordPress with Yoast: Yoast Premium's redirect manager, or on free Yoast the free Redirection plugin, adds a 301 in a minute.",
    wordpress: "In WordPress: the free Redirection plugin adds a 301 in a minute.",
    wix: "In Wix: SEO settings (Marketing & SEO), URL Redirect Manager.",
    shopify: "In Shopify: type \"URL redirects\" in the admin search bar and add the old and new paths.",
    squarespace: "In Squarespace: Settings, Developer tools, URL mappings, one line per redirect ending in 301.",
    webflow: "In Webflow: Site settings, Publishing, 301 redirects.",
  },
  analytics: {
    wordpress: "In WordPress: Google's Site Kit plugin connects Analytics and Search Console in one sign-in.",
    wix: "In Wix: Marketing Integrations, Google Analytics, then connect Search Console from SEO settings.",
    shopify: "In Shopify: install Google's \"Google & YouTube\" app, which sets up GA4 and conversion events.",
    squarespace: "In Squarespace: Settings, Developer tools, External API keys, Google Analytics.",
    webflow: "In Webflow: Site settings, Integrations, Google Analytics.",
  },
  images: {
    wordpress: "In WordPress: an image optimizer plugin (ShortPixel, Imagify or EWWW) resizes uploads and serves WebP; re-save the hero images at the width they are shown.",
    wix: "Wix compresses images itself, so the fix is the upload: replace oversized hero images with ones no wider than they display.",
    shopify: "Shopify already serves WebP and resized copies; upload banners no wider than about 2,000 pixels and check the theme's image-size setting.",
    squarespace: "Squarespace resizes images itself; replace very large uploads, especially banners and backgrounds.",
    webflow: "In Webflow: the Assets panel can compress and convert images to WebP in bulk.",
  },
  robots: {
    yoast: "In Yoast: Tools, File editor, robots.txt.",
    rankmath: "In Rank Math: General Settings, Edit robots.txt.",
    wordpress: "The robots.txt file sits in the site's root at the host; an SEO plugin such as Yoast can edit it from the dashboard.",
    wix: "In Wix: SEO settings, Robots.txt Editor.",
    shopify: "In Shopify: add a robots.txt.liquid template under Online Store, Themes, Edit code.",
  },
  ageGate: {
    wordpress: "In WordPress: an age verification plugin that shows an overlay on top of the page, so the content underneath stays readable to search engines.",
    wix: "In Wix: an age verification app from the App Market, set to show as an overlay.",
    shopify: "In Shopify: an age verification app from the App Store, set to show as an overlay rather than redirecting.",
    squarespace: "In Squarespace: a site-wide overlay (announcement or custom code block) rather than a separate gate page.",
  },
  schema: {
    yoast: "In Yoast: Settings, Site representation: choose Organization, add the logo, then list every social and directory profile.",
    rankmath: "In Rank Math: Titles & Meta, Local SEO: choose Organization, add the logo and the profile links.",
    wordpress: "An SEO plugin (Yoast or Rank Math) writes Organization markup from its settings; add the logo and profile links there.",
    wix: "In Wix: SEO settings, Business info feeds Wix's own markup; extra profiles go in the page's Advanced SEO, Structured data markup.",
    shopify: "Most Shopify themes emit Organization markup from the store name and logo; add the social links in the theme editor so they are included.",
  },
  scripts: {
    elementor: "In Elementor: remove entrance animations and motion effects from the first section, and turn on its Performance settings (improved asset loading).",
    wordpress: "In WordPress: a caching plugin that defers JavaScript and combines CSS (WP Rocket, LiteSpeed Cache or Autoptimize), plus fewer Google Font weights.",
    wix: "In Wix: remove apps and embeds nobody uses; each one adds scripts to every page.",
    shopify: "In Shopify: uninstall apps you no longer use (they often leave scripts in the theme) and check the theme's speed notes.",
    squarespace: "In Squarespace: remove unused code injections and third-party blocks.",
  },
};

// The most specific instruction that applies: SEO plugin, then page builder, then platform.
export function tipFor(key, platform) {
  const t = TIPS[key];
  if (!t || !platform || !platform.name) return null;
  return (platform.seoPlugin && t[platform.seoPlugin]) || (platform.builder && t[platform.builder]) || t[platform.name] || null;
}

// ---------- self-test ----------
if (process.argv.includes("--selftest")) {
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}`); } };
  const wp = detectPlatform('<link rel="stylesheet" href="/wp-content/themes/x/style.css"><!-- This site is optimized with the Yoast SEO plugin --><div class="elementor">');
  check("WordPress detected from wp-content", wp.name === "wordpress");
  check("Yoast detected", wp.seoPlugin === "yoast");
  check("Elementor detected", wp.builder === "elementor");
  check("WordPress has no native analytics", wp.nativeAnalytics === false);
  const wix = detectPlatform("<html>", { "x-wix-request-id": "abc" });
  check("Wix detected from its header", wix.name === "wix" && wix.nativeAnalytics === true);
  const shop = detectPlatform('<script src="https://cdn.shopify.com/s/x.js"></script><script>window.ShopifyAnalytics = {}</script>');
  check("Shopify detected from its CDN", shop.name === "shopify");
  check("Shopify's own analytics noticed", shop.nativeAnalytics === true);
  check("unknown stays unknown", detectPlatform("<html><body>hi</body></html>").name === null);
  check("plugin tip wins over platform tip", /Yoast SEO box/.test(tipFor("titles", wp)));
  check("builder tip used when the plugin has none", /Elementor/.test(tipFor("scripts", wp)));
  check("platform tip for Wix", /Pages & Menu/.test(tipFor("titles", wix)));
  check("no tip for an unknown platform", tipFor("titles", { name: null }) === null);
  check("no tip for an unknown key", tipFor("nope", wp) === null);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
