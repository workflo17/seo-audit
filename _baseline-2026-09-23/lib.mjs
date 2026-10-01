// Audit core: crawl + Lighthouse + rules engine. Shared by the CLI (audit.mjs)
// and the paste-a-website server (server.mjs).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, competitiveFinding, wordCount, host } from "./compete.mjs";
import { discoverCompetitors } from "./discover.mjs";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
                     "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);

// .env is read here so the CLIs and the server share one source of settings (keys are
// only set when the process does not already have them).
(function loadEnv(path = join(ROOT, ".env")) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let [, key, val] = m;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
})();

// The header identity on every document. Override per machine or per client run with
// BRAND_NAME, BRAND_CONTACT, BRAND_TAGLINE in .env or the environment.
export const BRAND = {
  name: process.env.BRAND_NAME || "Don · Web & AI for Local Business",
  contact: process.env.BRAND_CONTACT || "don@workflohq.com",
  tagline: process.env.BRAND_TAGLINE || "Site, search, and never-missed calls for NYC-area businesses",
};

// ---------- fetch (node first; curl --ssl-no-revoke fallback for this box) ----------
export async function fetchText(url) {
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 auditbot" }, signal: AbortSignal.timeout(20000) });
    return { ok: r.ok, status: r.status, finalUrl: r.url, text: r.ok ? await r.text() : "" };
  } catch {
    try {
      const text = execFileSync("curl", ["-sL", "--ssl-no-revoke", "--max-time", "20", "-A", "Mozilla/5.0 auditbot", url], { encoding: "utf8", maxBuffer: 20e6 });
      return { ok: text.length > 0, status: text.length ? 200 : 0, finalUrl: url, text };
    } catch { return { ok: false, status: 0, finalUrl: url, text: "" }; }
  }
}
async function reachable(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
    return r.status < 400 || r.status === 403 || r.status === 405;
  } catch { return null; } // null = could not check (don't call it broken)
}
async function existsUrl(url) { const r = await fetchText(url); return r.ok && r.text.length > 0 && !/not found|404/i.test(r.text.slice(0, 300)); }

// ---------- html mining ----------
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
  ndash: "-", mdash: "-", hellip: "...", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", laquo: "«", raquo: "»",
  eacute: "é", egrave: "è", ntilde: "ñ", uuml: "ü", ouml: "ö", auml: "ä", ccedil: "ç", agrave: "à", aacute: "á", iacute: "í", oacute: "ó", uacute: "ú" };
const cp = n => { try { return String.fromCodePoint(n); } catch { return ""; } };
// Numeric entities and the named ones that actually turn up in titles; anything unknown
// is left as written rather than guessed.
export const decode = s => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => cp(+d))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
const strip = s => decode(s.replace(/\s+/g, " ").trim());
// One attribute's value whatever the quoting: name="v", name='v' or name=v. An apostrophe
// inside a double-quoted description no longer truncates it.
export const attr = (tag, name) => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};
export function mine(html) {
  const get = re => { const m = html.match(re); return m ? strip(m[1]) : null; };
  const all = re => [...html.matchAll(re)];
  const title = get(/<title[^>]*>([\s\S]*?)<\/title>/i);
  // Attribute order is not fixed in the wild, so find the tag first and read it second.
  const metas = all(/<meta\b[^>]*>/gi).map(m => m[0]);
  const metaBy = (key, val) => metas.find(t => (attr(t, key) || "").toLowerCase() === val);
  const descTag = metaBy("name", "description");
  const metaDesc = descTag ? (strip(attr(descTag, "content") || "") || null) : null;
  const viewport = !!metaBy("name", "viewport");
  const h1s = all(/<h1[^>]*>([\s\S]*?)<\/h1>/gi).map(m => strip(m[1].replace(/<[^>]+>/g, "")));
  const imgs = all(/<img\b[^>]*>/gi).map(m => m[0]);
  const imgsWithAlt = imgs.filter(t => (attr(t, "alt") || "").trim().length > 0).length;
  const tels = all(/href=["']?tel:([^"'\s>]+)/gi).map(m => m[1]);
  const phoneRe = /(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const phones = [...new Set((noScript.match(phoneRe) || []).map(p => p.replace(/\D/g, "").slice(-10)))];
  const ldTypes = all(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)
    .flatMap(m => { try { const j = JSON.parse(m[1]); return [].concat(j).flatMap(x => x["@type"] ? [].concat(x["@type"]) : (x["@graph"] || []).flatMap(g => [].concat(g["@type"] || []))); } catch { return []; } });
  const canonical = /<link[^>]+rel=["']canonical["']/i.test(html);
  const ogTitle = !!metaBy("property", "og:title");
  const analytics = /gtag\(|google-analytics|googletagmanager|fbq\(|plausible|umami|clarity\.ms/i.test(html);
  const favicon = /<link[^>]+rel=["'][^"']*icon[^"']*["']/i.test(html);
  const copyYears = all(/(?:©|&copy;|copyright)[^<]{0,60}?((?:19|20)\d{2})/gi).map(m => +m[1]);
  const copyrightYear = copyYears.length ? Math.max(...copyYears) : null;
  return { title, metaDesc, viewport, h1s, imgCount: imgs.length, imgsWithAlt, tels, phones, ldTypes,
           canonical, ogTitle, analytics, favicon, copyrightYear };
}
const KEYSTOP = new Set("the a an and or of in on for with to your our we you at from by is are home page welcome llc inc co this that all more".split(" "));
export const keywords = s => [...new Set((s || "").toLowerCase().match(/[a-z]{4,}/g) || [])].filter(w => !KEYSTOP.has(w));

// ---------- inner-page crawl ----------
function internalLinks(html, base) {
  const host = new URL(base).host;
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]+href=["']([^"'#]+)["']/gi)) {
    let u; try { u = new URL(m[1], base); } catch { continue; }
    if (u.host !== host) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|zip|docx?)$/i.test(u.pathname)) continue;
    if (/^(mailto|tel|javascript):/i.test(m[1])) continue;
    u.hash = ""; u.search = "";
    const s = u.href.replace(/\/$/, "");
    if (s !== base.replace(/\/$/, "")) seen.add(s);
  }
  return [...seen];
}
async function crawlPages(homeHtml, base, max = 5) {
  const links = internalLinks(homeHtml, base);
  const pages = [];
  for (const url of links.slice(0, max)) {
    const r = await fetchText(url);
    if (!r.ok) { pages.push({ url, ok: false }); continue; }
    const m = mine(r.text);
    pages.push({ url, ok: true, path: new URL(url).pathname || "/", title: m.title, metaDesc: m.metaDesc, h1Count: m.h1s.length });
  }
  // broken-link sample across the rest
  let broken = 0, checked = 0;
  for (const url of links.slice(max, max + 10)) {
    const r = await reachable(url);
    if (r === null) continue;
    checked++; if (!r) broken++;
  }
  return { pages, linkSample: { checked, broken }, totalInternal: links.length };
}

// ---------- lighthouse ----------
// Windows Lighthouse often crashes on temp-profile cleanup AFTER writing the
// report: success is judged by the report file, never the exit code.
// Pinned: 13.5.0 (September 2026) dies at config time with the category filter ("Failed to
// find dependency RobotsTxt for AgentResourceDiscovery") and writes no report, so every
// score came back unmeasured. Move the pin only after a test run against the fixture.
export const LIGHTHOUSE = "lighthouse@13.4.1";
export function runLighthouse(url, outPath, extraFlags = "") {
  try {
    execSync(`npx --yes ${LIGHTHOUSE} "${url}" --quiet --output=json --output-path="${outPath}" ` +
      `--only-categories=performance,seo,accessibility,best-practices ` +
      `${extraFlags} --chrome-flags="--headless=new"`, { stdio: "pipe", timeout: 240000, env: { ...process.env, CHROME_PATH: EDGE } });
  } catch {}
}
export function parseLighthouse(outPath) {
  try {
    const lh = JSON.parse(readFileSync(outPath, "utf8"));
    // A run can fail and still write a full report: NO_FCP, a navigation error, a page
    // that never painted. Every category score comes back null, and treating null as 0
    // would print "speed 0/100" for a site nobody actually managed to measure. That is a
    // worse lie than declining to score it, so a failed run is reported as a failed run.
    if (lh.runtimeError?.code) return { ok: false, err: `${lh.runtimeError.code}: ${String(lh.runtimeError.message || "").slice(0, 160)}` };
    if (lh.categories?.performance?.score === null && lh.categories?.seo?.score === null)
      return { ok: false, err: "Lighthouse produced no scores for this page" };
    const cat = k => Math.round((lh.categories[k]?.score ?? 0) * 100);
    const met = k => ({ v: lh.audits[k]?.displayValue || null, n: lh.audits[k]?.numericValue ?? null, s: lh.audits[k]?.score ?? null });
    const opportunities = Object.values(lh.audits)
      .filter(a => a.details?.type === "opportunity" && a.score !== null && a.score < 0.9 && (a.details.overallSavingsMs || 0) > 100)
      .sort((a, b) => (b.details.overallSavingsMs || 0) - (a.details.overallSavingsMs || 0))
      .slice(0, 6).map(a => ({ title: a.title, save: Math.round(a.details.overallSavingsMs / 100) / 10 + "s" }));
    const flag = k => lh.audits[k] && lh.audits[k].score !== null && lh.audits[k].score < 0.9;
    // Every failing audit, kept for the pro report's appendix (the demo report ignores it).
    const failures = Object.values(lh.audits)
      .filter(a => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "notApplicable")
      .map(a => ({ id: a.id, title: a.title, group: a.id, display: a.displayValue || null }));
    return { ok: true, perf: cat("performance"), seo: cat("seo"), a11y: cat("accessibility"), bp: cat("best-practices"),
      lcp: met("largest-contentful-paint"), cls: met("cumulative-layout-shift"), tbt: met("total-blocking-time"),
      fcp: met("first-contentful-paint"), si: met("speed-index"), ttfb: met("server-response-time"),
      opportunities, failures, tapTargets: flag("tap-targets"), fontSize: flag("font-size"), consoleErrors: flag("errors-in-console") };
  } catch (e) { return { ok: false, err: String(e).slice(0, 200) }; }
}
// Run it, and if the run failed rather than the site being slow, run it once more:
// NO_FCP and navigation errors are usually a busy machine, not a broken page.
export function measureLighthouse(url, outPath, extraFlags = "") {
  runLighthouse(url, outPath, extraFlags);
  let r = parseLighthouse(outPath);
  if (r.ok) return r;
  runLighthouse(url, outPath, extraFlags);
  const second = parseLighthouse(outPath);
  return second.ok ? { ...second, retried: true } : { ...second, retried: true, firstError: r.err };
}
export function lighthouse(url, outDir) {
  const out = join(outDir, "lighthouse.json");
  return measureLighthouse(url, out);
}

// ---------- pdf ----------
export function printPdf(htmlPath, pdfPath) {
  execSync(`"${EDGE}" --headless=new --disable-gpu --no-pdf-header-footer ` +
    `--print-to-pdf="${pdfPath}" "${htmlPath}"`, { stdio: "pipe", timeout: 90000 });
}

// ---------- the audit ----------
const norm = p => (p || "").replace(/\D/g, "").slice(-10);
export async function runAudit(opts, stage = () => {}) {
  const { name, url, gphone, town, rating, reviews } = opts;
  // Up to three competitors: the UI's list, the CLI's repeated --competitor, or the single
  // field older callers still send. The site itself is never its own competitor.
  const sameAs = (a, b) => String(a).replace(/\/+$/, "").toLowerCase() === String(b).replace(/\/+$/, "").toLowerCase();
  const competitors = [...new Set([].concat(opts.competitors || [], opts.competitor || []).filter(Boolean))]
    .filter(c => !sameAs(c, url)).slice(0, 3);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const outDir = join(ROOT, "out", slug);
  mkdirSync(outDir, { recursive: true });

  stage("Fetching the homepage…");
  const page = await fetchText(url);
  if (!page.ok) throw new Error("could not fetch " + url);
  const site = mine(page.text);
  const https = page.finalUrl.startsWith("https:");
  const base = page.finalUrl.replace(/\/$/, "");

  stage("Crawling inner pages…");
  const crawl = await crawlPages(page.text, page.finalUrl);
  stage("Checking sitemap and robots…");
  const hasSitemap = await existsUrl(base + "/sitemap.xml");
  const hasRobots = await existsUrl(base + "/robots.txt");

  stage("Running Lighthouse, 60 to 120 seconds…");
  const lh = lighthouse(page.finalUrl, outDir);

  // Head to head: the same homepage checks, run on this site and on each competitor back
  // to back, so the report can say where this site is behind and what puts it on top.
  const localSchema = types => types.some(t => /LocalBusiness|Organization|HomeAndConstructionBusiness|Restaurant|Dentist|Store|ProfessionalService/i.test(t));
  const card = (u, m, html, lhr) => ({
    url: u, ok: true, title: m.title, metaDesc: !!m.metaDesc, words: wordCount(html), https: u.startsWith("https:"),
    viewport: m.viewport, hasLocalSchema: localSchema(m.ldTypes), telLink: m.tels.length > 0, analytics: m.analytics,
    ogTitle: m.ogTitle, altPct: m.imgCount ? Math.round(m.imgsWithAlt / m.imgCount * 100) : 100, ttfbMs: null, compressed: null,
    lh: lhr.ok ? { perf: lhr.perf, seo: lhr.seo, a11y: lhr.a11y, bp: lhr.bp, lcp: lhr.lcp?.v || null, cls: lhr.cls?.v || null } : null,
  });
  // Competitors found the way a customer finds them: a search for what the site says it does
  // plus where it is, filling the list up to three when the run asks for it.
  let discovery = null;
  if (opts.findCompetitors && competitors.length < 3) {
    stage("Searching for competitors…");
    discovery = await discoverCompetitors({ url: page.finalUrl, name, town, title: site.title, h1s: site.h1s, metaDesc: site.metaDesc,
      html: page.text, exclude: competitors, want: 3 - competitors.length });
    stage(discovery.picked.length ? `Found ${discovery.picked.map(host).join(", ")} by searching for "${discovery.queries[0]}".` : discovery.note);
    competitors.push(...discovery.picked);
  }
  let competition = null;
  if (competitors.length) {
    const self = card(page.finalUrl, site, page.text, lh);
    const mineKw = new Set(keywords([site.title, site.metaDesc, ...site.h1s].join(" ")));
    const comps = [];
    for (const [i, c] of competitors.entries()) {
      stage(`Reading competitor ${i + 1} of ${competitors.length}…`);
      const found = !!discovery && discovery.picked.includes(c);
      const r = await fetchText(c);
      if (!r.ok) { comps.push({ url: c, ok: false, found }); continue; }
      const cm = mine(r.text);
      stage(`Lighthouse on ${host(r.finalUrl)}, 60 to 120 seconds…`);
      const clh = measureLighthouse(r.finalUrl, join(outDir, `lighthouse-competitor${i + 1}.json`));
      const gap = keywords([cm.title, cm.metaDesc, ...cm.h1s].join(" ")).filter(w => !mineKw.has(w)).slice(0, 8);
      comps.push({ ...card(r.finalUrl, cm, r.text, clh), gap, found });
    }
    competition = { self, competitors: comps, discovery, ...compare(self, comps) };
  }

  stage("Scoring the findings…");
  const gph = norm(gphone);
  const sitePhones = new Set([...site.phones, ...site.tels.map(norm)]);
  const napMismatch = !!(gph && sitePhones.size > 0 && !sitePhones.has(gph));
  const altPct = site.imgCount ? Math.round(site.imgsWithAlt / site.imgCount * 100) : 100;
  const hasLocalSchema = localSchema(site.ldTypes);
  const year = new Date().getFullYear();
  const staleCopyright = site.copyrightYear && site.copyrightYear <= year - 2 ? site.copyrightYear : null;
  const pagesOk = crawl.pages.filter(p => p.ok);
  const titles = pagesOk.map(p => p.title).filter(Boolean);
  const dupTitles = titles.length !== new Set(titles).size || (site.title && titles.includes(site.title));
  const pagesNoMeta = pagesOk.filter(p => !p.metaDesc).length;

  const F = [];
  const add = (w, title, cost, fix, effort) => F.push({ w, title, cost, fix, effort });
  if (!site.viewport) add(100, "The site does not work on phones",
    "Most local searches happen on a phone. A site with no mobile layout loses those visitors in the first five seconds.",
    "Rebuild mobile-first; every page readable and tappable on a phone.", "1-2 days");
  else if (lh.ok && lh.perf < 50) add(85, `The site loads slowly on phones (${lh.perf}/100)`,
    "Slow pages bleed visitors before they see the work; speed is also a Google ranking input.",
    "Compress images, cut render-blocking scripts, target under 2.5s for when the page appears.", "1 day");
  if (!https) add(90, "The site is not served over HTTPS",
    "Browsers mark it 'Not secure' in the address bar; that label costs trust and rankings.",
    "Install a certificate and force HTTPS site-wide.", "1 hour");
  if (napMismatch) add(95, "Google lists a different phone number than the site",
    "Customers who find the business on Google may be calling a number that isn't the office. Every mismatched call is an invisible lost job.",
    `Align the number everywhere: site says ${[...sitePhones][0]?.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")}, Google says ${gphone}. Pick the canonical one, fix the other.`, "15 minutes");
  if (site.tels.length === 0) add(80, "No tap-to-call link anywhere on the page",
    "On a phone, a number you can't tap is a number most people won't dial.",
    "Wrap every phone number in a tap-to-call link; add a sticky call button on mobile.", "1 hour");
  if (lh.ok && lh.perf >= 50 && lh.lcp.n > 4000) add(75, "The page takes " + lh.lcp.v + " to appear",
    "Every extra second of load time costs conversions on mobile connections.",
    "Optimize the hero image and defer non-critical scripts.", "1 day");
  if (!hasLocalSchema) add(70, "Google can't read the business details (no business schema)",
    "Structured data feeds the Google panel, maps, and rich results. Without it the listing works on luck.",
    "Add business schema (the structured data Google reads): name, address, phone, hours, service area.", "2 hours");
  if (crawl.linkSample.broken > 0) add(68, `${crawl.linkSample.broken} broken link${crawl.linkSample.broken > 1 ? "s" : ""} in a ${crawl.linkSample.checked}-link sample`,
    "Broken links read as neglect to visitors and to Google alike.",
    "Fix or remove every dead link; re-check quarterly.", "1 hour");
  if (!site.title || site.title.length < 15 || site.title.length > 65) add(60, "The page title is " + (!site.title ? "missing" : site.title.length < 15 ? "too short to rank" : "too long and gets cut off"),
    "The title is the headline Google shows; a weak one loses clicks to whoever wrote a better one.",
    "Write a 50 to 60 character title: service + town + business name.", "30 minutes");
  if (!site.metaDesc) add(58, "No meta description on the homepage",
    "Google improvises the snippet under the listing; improvised snippets don't sell.",
    "Write a 150-character description with the offer and the town in it.", "15 minutes");
  if (pagesNoMeta > 0) add(56, `${pagesNoMeta} of ${pagesOk.length} inner pages have no meta description`,
    "Every page is a possible entry from search; blank snippets waste those doors.",
    "Write one per page: what's on it, for whom, where.", "1 hour");
  const gapWords = competition ? [...new Set(competition.competitors.flatMap(c => c.gap || []))] : [];
  if (gapWords.length >= 3) add(55, "A competitor ranks for words this site never says",
    "Search can only match words that exist on the page.",
    "Work these into real page copy: " + gapWords.slice(0, 6).join(", ") + ".", "2 hours");
  // One finding carries the whole head-to-head; the rule for each underlying gap still fires.
  const cf = competitiveFinding(competition);
  if (cf) add(cf.w, cf.title, cf.cost, cf.fix, cf.effort);
  if (dupTitles) add(52, "Multiple pages share the same title",
    "Duplicate titles make pages compete with each other in search instead of covering more ground.",
    "Give every page a unique title for its own service or topic.", "1 hour");
  if (staleCopyright) add(50, `The footer says © ${staleCopyright}`,
    "A years-old copyright line tells visitors nobody is home.",
    "Update the year (or generate it automatically): a thirty-second fix.", "15 minutes");
  if (!site.analytics) add(48, "No analytics installed",
    "Nobody is measuring what visitors do, so every marketing decision is a guess.",
    "Install Google Analytics (free) and wire call/quote clicks as conversions.", "1 hour");
  if (!hasSitemap && !hasRobots) add(45, "No sitemap.xml or robots.txt",
    "Without a sitemap, Google discovers pages by accident.",
    "Publish both and submit the sitemap in Search Console.", "1 hour");
  if (altPct < 50 && site.imgCount > 3) add(40, `Only ${altPct}% of images have alt text`,
    "Images without descriptions are invisible to search and to screen readers.",
    "Describe every photo: service + location beats 'IMG_4021'.", "2 hours");
  if (!site.ogTitle) add(35, "No social preview tags",
    "Shared links show up bare on Facebook, iMessage, and WhatsApp: no image, no pitch.",
    "Add social preview tags: title, description, and a real photo.", "1 hour");
  if (!site.favicon) add(25, "No favicon",
    "The browser-tab icon is small trust; a blank one reads unfinished.",
    "Add a favicon from the logo.", "15 minutes");
  F.sort((a, b) => b.w - a.w);

  const sev = w => w >= 85 ? "critical" : w >= 65 ? "high" : w >= 45 ? "medium" : "low";
  const data = { name, url: page.finalUrl, town, date: new Date().toISOString().slice(0, 10),
    rating, reviews, gphone, lighthouse: lh,
    site: { ...site, https, hasSitemap, hasRobots, altPct, hasLocalSchema },
    crawl, napMismatch, competition, discovery,
    findings: F.map(f => ({ ...f, sev: sev(f.w) })),
    fixes: F.slice(0, 5), slug, outDir };
  writeFileSync(join(outDir, "audit.json"), JSON.stringify(data, null, 2));
  return data;
}
