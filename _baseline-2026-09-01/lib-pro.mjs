// Deep audit engine: the owner-only "full" mode. The demo pipeline in lib.mjs is
// untouched and still powers the paste-a-website teaser; this module adds:
//   · a site-wide crawl (sitemap-seeded BFS, every page mined) instead of 5 inner pages
//   · a technical-health probe (redirect canonicalization, 404 handling, security
//     headers, compression, HTTP version, TTFB, robots + sitemap validation)
//   · a real link check across every internal link found, plus an external sample
//   · Lighthouse on BOTH mobile and desktop
//   · category scores (speed / content / technical / local / trust) and a work plan
// Everything is local: curl + headless Edge + Lighthouse, no API keys, no third party.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, mine, keywords, runLighthouse, parseLighthouse } from "./lib.mjs";

const UA = "Mozilla/5.0 (compatible; auditbot/1.0; +local SEO audit)";
const NULLDEV = process.platform === "win32" ? "NUL" : "/dev/null";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- fetching ----------
// Node fetch first, curl --ssl-no-revoke as the fallback (AVG intercepts TLS on this box).
export async function fetchPage(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
    const text = r.ok ? await r.text() : "";
    return { ok: r.ok, status: r.status, finalUrl: r.url, text, ms: Date.now() - t0,
             bytes: Buffer.byteLength(text), headers: Object.fromEntries(r.headers) };
  } catch {
    try {
      const text = execFileSync("curl", ["-sL", "--ssl-no-revoke", "--max-time", "20", "-A", UA, url],
        { encoding: "utf8", maxBuffer: 30e6 });
      return { ok: text.length > 0, status: text.length ? 200 : 0, finalUrl: url, text,
               ms: Date.now() - t0, bytes: Buffer.byteLength(text), headers: {} };
    } catch { return { ok: false, status: 0, finalUrl: url, text: "", ms: Date.now() - t0, bytes: 0, headers: {} }; }
  }
}

// Transport-level facts node fetch hides: HTTP version, TTFB, redirect count, raw headers.
export function probe(url, { follow = true } = {}) {
  const args = ["-sS", "-o", NULLDEV, "-D", "-", "--ssl-no-revoke", "--max-time", "25", "-A", UA,
    "-H", "Accept-Encoding: gzip, br",
    "-w", "\nMETRICS %{http_code}|%{http_version}|%{time_starttransfer}|%{time_total}|%{size_download}|%{num_redirects}|%{url_effective}\n"];
  if (follow) args.push("-L");
  args.push(url);
  let out;
  try {
    out = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 8e6, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // Windows schannel throws on quirks that don't matter here ("missing close_notify",
    // a wrong-principal cert on a www host that doesn't exist). If curl still printed
    // headers before it died, that answer is real, so parse it. Otherwise report the failure.
    out = e.stdout || "";
    if (!/^HTTP\//m.test(out)) return { ok: false, err: String(e.message || e).split("\n")[0].slice(0, 160) };
  }
  try {
    const line = out.split(/\r?\n/).find(l => l.startsWith("METRICS "));
    const [status, httpVersion, ttfb, total, size, redirects, finalUrl] = (line || "").slice(8).split("|");
    // -D - dumps a header block per hop; the last block describes the page we landed on.
    const blocks = out.split(/\r?\n\r?\n/).filter(b => /^HTTP\//m.test(b));
    const last = blocks[blocks.length - 1] || "";
    const headers = {};
    for (const l of last.split(/\r?\n/).slice(1)) {
      const i = l.indexOf(":");
      if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
    }
    const firstStatus = +((blocks[0] || "").match(/^HTTP\/[\d.]+\s+(\d{3})/m) || [])[1] || null;
    // No METRICS line means curl died mid-transfer; the last header block still tells us
    // what the server answered, which is all the redirect/404 checks need.
    if (!line) {
      const mt = last.match(/^HTTP\/([\d.]+)\s+(\d{3})/m) || [];
      return { ok: true, partial: true, status: +mt[2] || 0, firstStatus, httpVersion: mt[1] || null,
               ttfbMs: null, totalMs: null, bytes: 0, redirects: blocks.length - 1, finalUrl: url, headers };
    }
    return { ok: true, status: +status || 0, firstStatus, httpVersion, ttfbMs: Math.round(+ttfb * 1000),
             totalMs: Math.round(+total * 1000), bytes: +size || 0, redirects: +redirects || 0,
             finalUrl: finalUrl || url, headers };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 160) }; }
}

// ---------- html mining (adds to lib.mjs's mine()) ----------
const decode = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&rsquo;/g, "'").replace(/&nbsp;/g, " ");
const clean = s => decode(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

export function mineDeep(html, url) {
  const base = mine(html);
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ").replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  const wordCount = (clean(body).match(/[A-Za-z][A-Za-z'’-]{1,}/g) || []).length;
  const canonicalTag = (html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i) || [])[0] || "";
  const canonicalHref = (canonicalTag.match(/href=["']([^"']+)["']/i) || [])[1] || null;
  const robotsMeta = (html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i) || [])[1] || "";
  const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map(m => ({ lvl: +m[1], text: clean(m[2]).slice(0, 120) }));
  const mixed = [...new Set([...html.matchAll(/(?:src|href)=["'](http:\/\/[^"']+)["']/gi)].map(m => m[1]))]
    .filter(u => !/^http:\/\/(localhost|127\.)/.test(u));
  const links = [];
  let host = null; try { host = new URL(url).host; } catch {}
  for (const m of html.matchAll(/<a\b[^>]+href=["']([^"']+)["']/gi)) {
    const raw = m[1];
    if (/^(mailto|tel|javascript|sms):/i.test(raw) || raw.startsWith("#")) continue;
    let u; try { u = new URL(raw, url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    u.hash = "";
    links.push({ href: u.href, internal: u.host === host });
  }
  const emails = [...new Set([...html.matchAll(/href=["']mailto:([^"'?]+)["']/gi)].map(m => m[1].toLowerCase()))];
  const hasMap = /google\.com\/maps|maps\.google|mapbox|openstreetmap/i.test(html);
  const hasForm = /<form\b/i.test(html);
  const addressish = /\b\d{1,6}\s+[A-Z][A-Za-z.'-]+\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|hwy|highway|pkwy|pl|place|ct|court|ste|suite)\b/i.test(clean(html));
  const hoursish = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*(?:–|-|to|:)/i.test(clean(html)) && /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(clean(html));
  return { ...base, wordCount, canonicalHref, robotsMeta, noindex: /noindex/i.test(robotsMeta),
           nofollowMeta: /nofollow/i.test(robotsMeta), headings, mixed, links, emails, hasMap, hasForm,
           addressish, hoursish, text: clean(body).slice(0, 20000) };
}

// ---------- robots.txt + sitemaps ----------
export function parseRobots(text) {
  const sitemaps = [], groups = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const key = k.trim().toLowerCase(), val = rest.join(":").trim();
    if (key === "sitemap") sitemaps.push(val);
    else if (key === "user-agent") { current = { ua: val.toLowerCase(), disallow: [], allow: [] }; groups.push(current); }
    else if (current && key === "disallow" && val) current.disallow.push(val);
    else if (current && key === "allow" && val) current.allow.push(val);
  }
  const star = groups.find(g => g.ua === "*");
  return { sitemaps, groups, disallow: star ? star.disallow : [], allow: star ? star.allow : [] };
}
const blockedBy = (pathname, disallow) => disallow.find(d => d === "/" ? pathname === "/" || pathname.startsWith("/") : pathname.startsWith(d.replace(/\*$/, ""))) || null;

export async function readSitemaps(base, robots) {
  const candidates = [...new Set([...(robots?.sitemaps || []), base + "/sitemap.xml", base + "/sitemap_index.xml"])];
  const urls = new Set();
  const sources = [];
  let indexed = 0;
  for (const sm of candidates.slice(0, 4)) {
    const r = await fetchPage(sm);
    if (!r.ok || !/<(urlset|sitemapindex)/i.test(r.text)) { sources.push({ url: sm, ok: false }); continue; }
    const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decode(m[1]));
    const lastmods = [...r.text.matchAll(/<lastmod>/gi)].length;
    if (/<sitemapindex/i.test(r.text)) {
      indexed++;
      sources.push({ url: sm, ok: true, index: true, children: locs.length, lastmods });
      for (const child of locs.slice(0, 5)) {
        const c = await fetchPage(child);
        if (!c.ok) continue;
        for (const m of c.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) urls.add(decode(m[1]));
      }
    } else {
      sources.push({ url: sm, ok: true, index: false, count: locs.length, lastmods });
      for (const l of locs) urls.add(l);
    }
    if (urls.size) break; // first sitemap that yields URLs wins
  }
  return { found: sources.some(s => s.ok), sources, urls: [...urls], indexed };
}

// ---------- crawl ----------
const skipExt = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|docx?|xlsx?|pptx?|mp[34]|mov|avi|css|js|json|xml|txt)$/i;
const canonicalKey = u => u.replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/, "").toLowerCase();

export async function deepCrawl({ base, seeds = [], maxPages = 40, concurrency = 4, disallow = [], stage = () => {} }) {
  const host = new URL(base).host;
  // Dedupe the seed list up front: the sitemap almost always repeats the homepage the
  // crawl already starts from, and "site.com" / "site.com/" are the same page.
  const queue = [];
  const queued = new Set();
  for (const u of [base, ...seeds]) {
    try { if (new URL(u).host !== host) continue; } catch { continue; }
    const key = canonicalKey(u);
    if (queued.has(key)) continue;
    queued.add(key); queue.push(u);
  }
  const pages = [];
  const inbound = new Map();      // canonical key -> how many internal links point at it
  const externalLinks = new Map(); // href -> first page that linked to it
  const internalLinks = new Map(); // href -> first page that linked to it
  const skippedByRobots = [];
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length && pages.length < maxPages) {
      const url = queue[cursor++];
      if (!url) continue;
      let pathname = "/";
      try { pathname = new URL(url).pathname; } catch {}
      const block = blockedBy(pathname, disallow);
      if (block && url !== base) { skippedByRobots.push({ url, rule: block }); continue; }
      const t0 = Date.now();
      const p = probe(url, { follow: false });
      const r = await fetchPage(url);
      const rec = { url, status: p.ok ? p.status : r.status, ms: Date.now() - t0, ttfbMs: p.ok ? p.ttfbMs : null,
                    bytes: r.bytes, ok: r.ok };
      if (r.ok && /html/i.test(r.headers["content-type"] || "text/html")) {
        const m = mineDeep(r.text, r.finalUrl || url);
        Object.assign(rec, {
          path: (() => { try { return new URL(r.finalUrl || url).pathname || "/"; } catch { return url; } })(),
          title: m.title, titleLen: m.title ? m.title.length : 0, metaDesc: m.metaDesc,
          metaLen: m.metaDesc ? m.metaDesc.length : 0, h1s: m.h1s, headings: m.headings,
          wordCount: m.wordCount, imgCount: m.imgCount, imgsWithAlt: m.imgsWithAlt,
          canonicalHref: m.canonicalHref, noindex: m.noindex, ldTypes: m.ldTypes, viewport: m.viewport,
          tels: m.tels, phones: m.phones, mixed: m.mixed, hasMap: m.hasMap, hasForm: m.hasForm,
          addressish: m.addressish, hoursish: m.hoursish, analytics: m.analytics, ogTitle: m.ogTitle,
          internalOut: m.links.filter(l => l.internal).length, externalOut: m.links.filter(l => !l.internal).length,
          text: m.text,
        });
        for (const l of m.links) {
          if (l.internal) {
            const key = canonicalKey(l.href);
            inbound.set(key, (inbound.get(key) || 0) + 1);
            if (!internalLinks.has(l.href)) internalLinks.set(l.href, url);
            if (!queued.has(key) && !skipExt.test(new URL(l.href).pathname) && queue.length < maxPages * 4) {
              queued.add(key); queue.push(l.href);
            }
          } else if (!externalLinks.has(l.href)) externalLinks.set(l.href, url);
        }
      }
      pages.push(rec);
      if (pages.length % 5 === 0) stage(`Crawling… ${pages.length} pages read`);
      await sleep(120); // be a polite guest on someone else's server
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { pages, inbound, internalLinks, externalLinks, skippedByRobots, queuedTotal: queued.size };
}

// ---------- link checking ----------
async function linkStatus(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
    if (r.status === 405 || r.status === 403 || r.status === 501) {
      const g = await fetch(url, { method: "GET", redirect: "follow", headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
      return g.status;
    }
    return r.status;
  } catch {
    const p = probe(url);
    return p.ok ? p.status : 0;
  }
}
export async function checkLinks(entries, { concurrency = 6, stage = () => {} } = {}) {
  const out = [];
  let i = 0, done = 0;
  async function worker() {
    while (i < entries.length) {
      const e = entries[i++];
      const status = await linkStatus(e.url);
      done++;
      if (done % 20 === 0) stage(`Checking links… ${done}/${entries.length}`);
      // 0 = we could not reach it at all (DNS/TLS/timeout), reported separately from a 4xx.
      if (status === 0 || status >= 400) out.push({ ...e, status });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

// ---------- technical probes ----------
// Where one request lands after at most one hop, keeping the scheme and host (unlike
// canonicalKey, which deliberately ignores www, which is the whole point of this check).
function landing(url) {
  const p = probe(url, { follow: false });
  if (!p.ok) return { ok: false, status: null, to: null };
  if (p.status >= 300 && p.status < 400 && p.headers.location) {
    try { return { ok: true, status: p.status, to: new URL(p.headers.location, url).href.replace(/\/+$/, "").toLowerCase() }; } catch {}
  }
  return { ok: true, status: p.status, to: p.status === 200 ? url.replace(/\/+$/, "").toLowerCase() : null };
}

export async function techChecks(base, stage = () => {}) {
  const u = new URL(base);
  const apex = u.host.replace(/^www\./, "");
  const t = {};
  stage("Checking HTTPS, redirects and headers…");
  t.home = probe(base);
  t.httpVariant = landing("http://" + apex);
  t.wwwVariant = landing("https://www." + apex);
  t.apexVariant = landing("https://" + apex);
  t.httpsForced = t.httpVariant.ok ? /^https:/i.test(t.httpVariant.to || "") : null;
  // If one hostname simply doesn't answer, there is no duplicate to unify.
  t.hostUnified = !t.wwwVariant.ok || !t.apexVariant.ok ? true
    : t.wwwVariant.to && t.apexVariant.to ? t.wwwVariant.to === t.apexVariant.to : null;
  stage("Checking how the site answers a bad URL…");
  const missing = probe(base + "/this-page-should-not-exist-" + Date.now().toString(36), { follow: false });
  t.notFoundStatus = missing.ok ? missing.status : null;
  const h = t.home.ok ? t.home.headers : {};
  t.headers = {
    hsts: h["strict-transport-security"] || null,
    xcto: h["x-content-type-options"] || null,
    csp: h["content-security-policy"] ? "present" : null,
    referrer: h["referrer-policy"] || null,
    xfo: h["x-frame-options"] || null,
    encoding: h["content-encoding"] || null,
    cache: h["cache-control"] || null,
    server: h["server"] || null,
  };
  t.httpVersion = t.home.ok ? t.home.httpVersion : null;
  t.ttfbMs = t.home.ok ? t.home.ttfbMs : null;
  t.compressed = /gzip|br|deflate|zstd/i.test(t.headers.encoding || "");
  return t;
}

// ---------- scoring ----------
const CATS = { speed: 25, content: 25, tech: 20, local: 20, trust: 10 };
function scoreOf(findings, lhMobile) {
  const scores = {};
  for (const cat of Object.keys(CATS)) {
    const hit = findings.filter(f => f.cat === cat).reduce((a, f) => a + f.w, 0);
    // Diminishing returns rather than a straight subtraction, so a site with eight
    // problems still scores below one with three instead of both flooring at zero.
    scores[cat] = Math.max(0, Math.round(100 * Math.exp(-hit / 220)));
  }
  // Speed is measured, not inferred: Lighthouse owns that number when it ran.
  if (lhMobile.ok) scores.speed = lhMobile.perf;
  const overall = Math.round(Object.entries(CATS).reduce((a, [k, w]) => a + scores[k] * w, 0) / 100);
  return { ...scores, overall };
}

// ---------- the pro audit ----------
const norm = p => (p || "").replace(/\D/g, "").slice(-10);
const pretty = p => String(p).replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");

export async function runProAudit(opts, stage = () => {}) {
  const { name, url, gphone, town, rating, reviews } = opts;
  const competitors = (opts.competitors || [opts.competitor]).filter(Boolean);
  const maxPages = Math.max(5, Math.min(200, +opts.maxPages || 40));
  const slug = (name || new URL(url).hostname).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const outDir = join(ROOT, "out", slug);
  mkdirSync(outDir, { recursive: true });

  stage("Fetching the homepage…");
  const home = await fetchPage(url);
  if (!home.ok) throw new Error("could not fetch " + url);
  const site = mineDeep(home.text, home.finalUrl || url);
  const base = (home.finalUrl || url).replace(/\/$/, "");
  const https = base.startsWith("https:");

  stage("Reading robots.txt…");
  const robotsRes = await fetchPage(base + "/robots.txt");
  const robotsOk = robotsRes.ok && /user-agent|disallow|sitemap/i.test(robotsRes.text) && !/<html/i.test(robotsRes.text);
  const robots = robotsOk ? parseRobots(robotsRes.text) : null;

  stage("Reading sitemaps…");
  const sitemap = await readSitemaps(base, robots);

  stage(`Crawling the site, up to ${maxPages} pages…`);
  const crawl = await deepCrawl({ base, seeds: sitemap.urls.slice(0, maxPages), maxPages,
    disallow: robots?.disallow || [], stage });
  const htmlPages = crawl.pages.filter(p => p.ok && p.title !== undefined);

  stage("Checking every internal link…");
  const internalEntries = [...crawl.internalLinks].map(([u, from]) => ({ url: u, from, kind: "internal" }))
    .filter(e => !crawl.pages.some(p => canonicalKey(p.url) === canonicalKey(e.url) && p.ok));
  const externalEntries = [...crawl.externalLinks].map(([u, from]) => ({ url: u, from, kind: "external" })).slice(0, 60);
  const checkedCount = internalEntries.length + externalEntries.length;
  const badLinks = await checkLinks([...internalEntries, ...externalEntries], { stage });

  const tech = await techChecks(base, stage);

  stage("Running Lighthouse on mobile, 60 to 120 seconds…");
  runLighthouse(base, join(outDir, "lighthouse.json"));
  const lh = parseLighthouse(join(outDir, "lighthouse.json"));
  stage("Running Lighthouse on desktop, 60 to 120 seconds…");
  runLighthouse(base, join(outDir, "lighthouse-desktop.json"), "--preset=desktop");
  const lhDesktop = parseLighthouse(join(outDir, "lighthouse-desktop.json"));

  const comps = [];
  for (const c of competitors.slice(0, 3)) {
    stage("Reading a competitor…");
    const r = await fetchPage(c);
    if (!r.ok) { comps.push({ url: c, ok: false }); continue; }
    const cm = mineDeep(r.text, r.finalUrl || c);
    const mineKw = new Set(keywords([site.title, site.metaDesc, ...site.h1s, site.text].join(" ")));
    const gap = keywords([cm.title, cm.metaDesc, ...cm.h1s, cm.text].join(" ")).filter(w => !mineKw.has(w)).slice(0, 12);
    comps.push({ url: c, ok: true, title: cm.title, words: cm.wordCount, schema: cm.ldTypes,
                 https: (r.finalUrl || c).startsWith("https:"), gap });
  }

  stage("Scoring the findings…");
  // ---- aggregates the rules read from ----
  const gph = norm(gphone);
  const allPhones = new Set(htmlPages.flatMap(p => [...(p.phones || []), ...(p.tels || []).map(norm)]).filter(Boolean));
  const napMismatch = !!(gph && allPhones.size > 0 && !allPhones.has(gph));
  const napSplit = allPhones.size > 1;
  const titles = htmlPages.map(p => p.title).filter(Boolean);
  const dupTitleMap = titles.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map());
  const dupTitles = [...dupTitleMap].filter(([, n]) => n > 1);
  const metas = htmlPages.map(p => p.metaDesc).filter(Boolean);
  const dupMetas = [...metas.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map())].filter(([, n]) => n > 1);
  const noTitle = htmlPages.filter(p => !p.title);
  const badTitleLen = htmlPages.filter(p => p.title && (p.titleLen < 25 || p.titleLen > 65));
  const noMeta = htmlPages.filter(p => !p.metaDesc);
  const badMetaLen = htmlPages.filter(p => p.metaDesc && (p.metaLen < 70 || p.metaLen > 165));
  const noH1 = htmlPages.filter(p => (p.h1s || []).length === 0);
  const multiH1 = htmlPages.filter(p => (p.h1s || []).length > 1);
  const thin = htmlPages.filter(p => p.wordCount < 300);
  const noindexed = htmlPages.filter(p => p.noindex);
  const noCanonical = htmlPages.filter(p => !p.canonicalHref);
  const noViewport = htmlPages.filter(p => p.viewport === false);
  const mixedPages = htmlPages.filter(p => (p.mixed || []).length);
  const slowPages = htmlPages.filter(p => p.ttfbMs && p.ttfbMs > 800);
  const imgTotal = htmlPages.reduce((a, p) => a + (p.imgCount || 0), 0);
  const imgAlt = htmlPages.reduce((a, p) => a + (p.imgsWithAlt || 0), 0);
  const altPct = imgTotal ? Math.round(imgAlt / imgTotal * 100) : 100;
  const orphans = sitemap.urls.filter(u => {
    const key = canonicalKey(u);
    return key !== canonicalKey(base) && !crawl.inbound.get(key);
  }).slice(0, 25);
  // 401/403/429 usually means the far end blocks bots rather than a dead link, so
  // these are listed for review instead of counted as broken.
  const isBlocked = s => s === 401 || s === 403 || s === 429;
  const blockedLinks = badLinks.filter(l => isBlocked(l.status));
  const brokenInternal = badLinks.filter(l => l.kind === "internal" && !isBlocked(l.status));
  const brokenExternal = badLinks.filter(l => l.kind === "external" && !isBlocked(l.status));
  const sitemapMissingPages = htmlPages.filter(p => sitemap.found && !sitemap.urls.some(u => canonicalKey(u) === canonicalKey(p.url)));
  const hasLocalSchema = site.ldTypes.some(t => /LocalBusiness|Organization|HomeAndConstructionBusiness|Restaurant|Dentist|Store|ProfessionalService|Plumber|Electrician|Contractor/i.test(t));
  const schemaTypes = [...new Set(htmlPages.flatMap(p => p.ldTypes || []))];
  const telPages = htmlPages.filter(p => (p.tels || []).length);
  const year = new Date().getFullYear();
  const staleCopyright = site.copyrightYear && site.copyrightYear <= year - 2 ? site.copyrightYear : null;
  const townWords = keywords(town || "");
  const townCoverage = townWords.length
    ? htmlPages.filter(p => townWords.some(w => (p.text || "").toLowerCase().includes(w))).length
    : null;

  // ---- the rules ----
  const F = [];
  const add = (cat, w, title, cost, fix, effort, evidence = []) =>
    F.push({ cat, w, title, cost, fix, effort, evidence: evidence.slice(0, 8) });

  // speed
  if (lh.ok && lh.perf < 50) add("speed", 85, `Mobile speed scores ${lh.perf}/100`,
    "Slow pages bleed visitors before they see the work, and speed is a ranking input Google publishes.",
    "Compress and resize hero images, defer non-critical scripts, target first paint under 2.5 seconds.", "1-2 days",
    (lh.opportunities || []).map(o => `${o.title} (saves ${o.save})`));
  else if (lh.ok && lh.perf < 80) add("speed", 55, `Mobile speed scores ${lh.perf}/100, with real headroom left`,
    "Between 50 and 80 the page works but feels sluggish on a phone connection; the drop-off is invisible in analytics.",
    "Work the Lighthouse opportunity list top-down; each one is a measured saving.", "half a day",
    (lh.opportunities || []).map(o => `${o.title} (saves ${o.save})`));
  if (lh.ok && lh.lcp?.n > 4000) add("speed", 70, "Main content takes " + lh.lcp.v + " to appear on mobile",
    "Four seconds of blank screen on a phone is where most bounces happen.",
    "Optimize the largest image, preload the hero, and cut render-blocking CSS/JS.", "half a day");
  if (lh.ok && lh.cls?.s !== null && lh.cls.s < 0.5) add("speed", 45, "Layout shifts while the page loads (CLS " + (lh.cls.v || "high") + ")",
    "Buttons that jump cause mis-taps and abandoned calls.",
    "Give images and embeds explicit width/height, reserve space for banners and ads.", "2 hours");
  if (tech.ttfbMs && tech.ttfbMs > 800) add("speed", 50, `The server takes ${tech.ttfbMs}ms to answer (TTFB)`,
    "Nothing on the page can start until the server responds; this is pure dead time on every visit.",
    "Enable page caching or a CDN, or move off oversubscribed shared hosting.", "half a day");
  if (slowPages.length > 2) add("speed", 40, `${slowPages.length} pages answer slower than 800ms`,
    "The homepage may be cached while the money pages are not.",
    "Cache every template, not just the front page.", "2 hours", slowPages.slice(0, 6).map(p => `${p.path} (${p.ttfbMs}ms)`));
  if (tech.compressed === false) add("speed", 45, "Pages are served uncompressed",
    "Every visitor downloads several times more bytes than needed, on their data plan.",
    "Turn on gzip or brotli at the server or CDN. One config line, and no code has to change.", "15 minutes");
  if (tech.httpVersion && +String(tech.httpVersion).split(".")[0] < 2) add("speed", 30, `The site still runs on HTTP/${tech.httpVersion}`,
    "HTTP/1.1 loads assets in single file; HTTP/2 loads them in parallel.",
    "Enable HTTP/2 at the host or put the site behind a CDN that does.", "1 hour");

  // technical
  if (!https) add("tech", 95, "The site is not served over HTTPS",
    "Browsers label it 'Not secure' in the address bar; that label costs trust and rankings.",
    "Install a certificate and force HTTPS site-wide.", "1 hour");
  if (https && tech.httpsForced === false) add("tech", 70, "The http:// version does not redirect to https://",
    "Two live copies of the site split ranking signals and let visitors land on the insecure one.",
    "Add a permanent 301 from http to https for every path.", "30 minutes");
  if (tech.hostUnified === false) add("tech", 65, "www and non-www both serve the site without redirecting",
    "Google sees two sites competing with each other for the same words.",
    "Pick one hostname and 301 the other to it everywhere.", "30 minutes");
  if (tech.notFoundStatus && tech.notFoundStatus !== 404 && tech.notFoundStatus !== 410)
    add("tech", 55, `A missing page answers with HTTP ${tech.notFoundStatus} instead of 404`,
      "Soft 404s let Google index junk URLs and hide real broken links from every tool including this one.",
      "Return a real 404 status on unknown URLs, with a helpful page on top of it.", "1 hour");
  if (!robotsOk) add("tech", 45, "No robots.txt",
    "Crawlers get no guidance and no pointer to the sitemap.",
    "Publish robots.txt with a Sitemap: line and no blanket Disallow.", "15 minutes");
  else if ((robots?.disallow || []).includes("/")) add("tech", 100, "robots.txt blocks the entire site from search engines",
    "This single line can remove the whole site from Google.",
    "Remove the Disallow: / rule immediately, then request re-indexing in Search Console.", "15 minutes");
  if (!sitemap.found) add("tech", 55, "No XML sitemap",
    "Without one, Google finds pages only by following links, and misses anything buried.",
    "Generate sitemap.xml, reference it in robots.txt, submit it in Search Console.", "1 hour");
  else if (sitemap.urls.length && sitemapMissingPages.length > 2)
    add("tech", 40, `${sitemapMissingPages.length} live pages are missing from the sitemap`,
      "Pages outside the sitemap get crawled late or not at all.",
      "Regenerate the sitemap from the live route list and keep it automatic.", "1 hour",
      sitemapMissingPages.slice(0, 6).map(p => p.path));
  if (orphans.length) add("tech", 50, `${orphans.length} page${orphans.length > 1 ? "s have" : " has"} no internal links pointing at it`,
    "An orphan page can only be found by luck; it inherits no authority from the rest of the site.",
    "Link every page from a menu, a hub page, or related-content blocks.", "half a day",
    orphans.slice(0, 8));
  if (noindexed.length) add("tech", 90, `${noindexed.length} page${noindexed.length > 1 ? "s are" : " is"} marked noindex`,
    "A noindex tag removes the page from Google entirely; on a money page that is invisible revenue loss.",
    "Remove the noindex meta from anything that should rank.", "15 minutes",
    noindexed.slice(0, 8).map(p => p.path));
  if (brokenInternal.length) add("tech", 68, `${brokenInternal.length} broken internal link${brokenInternal.length > 1 ? "s" : ""}`,
    "Dead links waste crawl budget and read as neglect to a customer mid-decision.",
    "Fix or remove each one; re-check quarterly.", "2 hours",
    brokenInternal.slice(0, 8).map(l => `${l.status || "unreachable"} · ${l.url} (linked from ${l.from})`));
  if (brokenExternal.length > 2) add("tech", 35, `${brokenExternal.length} outbound links are dead`,
    "Links to sites that no longer exist date the page.",
    "Repoint or remove them.", "1 hour",
    brokenExternal.slice(0, 6).map(l => `${l.status || "unreachable"} · ${l.url}`));
  if (noCanonical.length > htmlPages.length / 2) add("tech", 45, `${noCanonical.length} of ${htmlPages.length} pages ${noCanonical.length === 1 ? "has" : "have"} no canonical tag`,
    "Without canonicals, parameter and trailing-slash variants become duplicate pages.",
    "Emit a self-referencing canonical on every template.", "2 hours");
  if (mixedPages.length) add("tech", 60, `${mixedPages.length} page${mixedPages.length > 1 ? "s load" : " loads"} insecure http:// assets`,
    "Mixed content triggers browser warnings and blocks images or scripts outright.",
    "Serve every asset over https.", "1 hour",
    mixedPages.slice(0, 5).map(p => `${p.path} (${p.mixed[0]})`));
  if (!tech.headers.hsts) add("tech", 25, "No HSTS header",
    "Without it a first visit can still be downgraded to http.",
    "Add Strict-Transport-Security once https is stable everywhere.", "15 minutes");
  if (!tech.headers.xcto) add("tech", 20, "No X-Content-Type-Options header",
    "A one-line hardening header most hosts leave off.",
    "Add X-Content-Type-Options: nosniff.", "15 minutes");

  // content
  if (noTitle.length) add("content", 90, `${noTitle.length} page${noTitle.length > 1 ? "s have" : " has"} no title tag`,
    "The title is the headline Google shows; with none, the listing is whatever Google invents.",
    "Write a 50-60 character title per page: service + town + business.", "1 hour", noTitle.slice(0, 8).map(p => p.path));
  if (dupTitles.length) add("content", 62, `${dupTitles.length} title${dupTitles.length > 1 ? "s are" : " is"} used on more than one page`,
    "Duplicate titles make your own pages compete instead of covering more ground.",
    "Give every page a unique title for its own service or topic.", "2 hours",
    dupTitles.slice(0, 6).map(([t, n]) => `${n}× "${t}"`));
  if (badTitleLen.length) add("content", 45, `${badTitleLen.length} title${badTitleLen.length > 1 ? "s are" : " is"} the wrong length for a search result`,
    "Under 25 characters wastes the slot; over 65 gets truncated mid-word.",
    "Rewrite to 50-60 characters with the service and the town in front.", "2 hours",
    badTitleLen.slice(0, 6).map(p => `${p.path} (${p.titleLen} chars)`));
  if (noMeta.length) add("content", 58, `${noMeta.length} of ${htmlPages.length} pages ${noMeta.length === 1 ? "has" : "have"} no meta description`,
    "Google improvises the snippet under the listing, and improvised snippets do not sell.",
    "Write a 150-character description per page: what is on it, for whom, where.", "half a day",
    noMeta.slice(0, 8).map(p => p.path));
  if (dupMetas.length) add("content", 40, `${dupMetas.length} meta description${dupMetas.length > 1 ? "s are" : " is"} reused across pages`,
    "The same snippet on every result makes the whole site look like one thin page.",
    "One description per page, written for that page's offer.", "2 hours");
  if (badMetaLen.length > 2) add("content", 30, `${badMetaLen.length} meta descriptions are the wrong length`,
    "Short ones waste the space; long ones are cut mid-sentence.",
    "Target 120-155 characters.", "2 hours");
  if (noH1.length) add("content", 55, `${noH1.length} page${noH1.length > 1 ? "s have" : " has"} no H1 heading`,
    "The H1 tells both the visitor and the crawler what the page is about in one line.",
    "Add exactly one H1 per page, matching the page's search intent.", "2 hours", noH1.slice(0, 8).map(p => p.path));
  if (multiH1.length > 2) add("content", 28, `${multiH1.length} pages use more than one H1`,
    "Several competing headlines dilute the page's topic.",
    "Keep one H1 and demote the rest to H2.", "2 hours");
  if (thin.length) add("content", 52, `${thin.length} page${thin.length > 1 ? "s have" : " has"} under 300 words of content`,
    "Thin pages rarely rank for anything and give a visitor no reason to call.",
    "Expand each into a real service page: the problem, the process, the proof, the price range, the call to action.", "1-2 days",
    thin.slice(0, 8).map(p => `${p.path} (${p.wordCount} words)`));
  if (altPct < 60 && imgTotal > 5) add("content", 40, `Only ${altPct}% of ${imgTotal} images have alt text`,
    "Images without descriptions are invisible to image search and to screen readers.",
    "Describe every photo: service plus location beats 'IMG_4021'.", "2 hours");
  // Threshold scales with the site: on a one-page site, naming the town once is full coverage.
  if (townWords.length && townCoverage !== null && townCoverage < Math.max(1, Math.ceil(htmlPages.length * 0.3)))
    add("content", 48, `The service area is named on only ${townCoverage} of ${htmlPages.length} pages`,
      "Local search matches words that are actually on the page; leaving the town off most pages leaves the map to competitors.",
      `Work "${town}" and the surrounding towns into headings and body copy, not just the footer.`, "half a day");
  if (townWords.length && townCoverage !== null && htmlPages.length > 1 && townCoverage < htmlPages.length)
    add("content", 22, `${htmlPages.length - townCoverage} of ${htmlPages.length} pages never name the service area`,
      "Any page can be the one a searcher lands on, and a page that never says where you work cannot rank for where you work.",
      "Add the town to the title, the H1 or the opening line of the pages that are missing it.", "2 hours");
  for (const c of comps.filter(c => c.ok && c.gap.length >= 3)) {
    add("content", 50, "A competitor leads with words this site never uses",
      "Search can only match words that exist on the page.",
      `Work these into real copy: ${c.gap.slice(0, 8).join(", ")}.`, "half a day", [c.url]);
  }

  // local
  if (napMismatch) add("local", 95, "Google shows a different phone number than the website",
    "Customers who find the business on Google may be calling a number that is not the office. Every mismatched call is an invisible lost job.",
    `Align it everywhere: site says ${pretty([...allPhones][0] || "")}, Google says ${gphone}. Pick the canonical one and fix the other.`, "1 hour");
  if (napSplit) add("local", 60, `${allPhones.size} different phone numbers appear across the site`,
    "Inconsistent numbers confuse both customers and the local ranking signals that check them.",
    "One primary number everywhere; track campaigns with call tracking, not with a second listed number.", "1 hour",
    [...allPhones].map(pretty));
  if (!telPages.length) add("local", 80, "No tap-to-call link anywhere on the site",
    "On a phone, a number that cannot be tapped is a number most people will not dial.",
    "Wrap every number in a tel: link and add a sticky call button on mobile.", "1 hour");
  else if (telPages.length < htmlPages.length / 2) add("local", 45, `Only ${telPages.length} of ${htmlPages.length} pages ${telPages.length === 1 ? "has" : "have"} a tap-to-call link`,
    "Visitors land on inner pages from search, not just the homepage.",
    "Put the call button in the header or a sticky mobile bar so it is on every page.", "1 hour");
  if (!hasLocalSchema) add("local", 72, "No LocalBusiness schema, so Google cannot read the business details",
    "Structured data feeds the Google panel, maps, and rich results. Without it the listing runs on luck.",
    "Add LocalBusiness JSON-LD: name, address, phone, hours, service area, geo, sameAs links to the profiles.", "2 hours",
    schemaTypes.length ? ["found instead: " + schemaTypes.join(", ")] : []);
  if (!site.addressish && !htmlPages.some(p => p.addressish)) add("local", 55, "No street address in the page text",
    "Address, name and phone consistency is the backbone of local ranking, and customers look for it before calling.",
    "Put the full address in the footer of every page and on a contact page.", "1 hour");
  if (!htmlPages.some(p => p.hoursish)) add("local", 35, "No opening hours anywhere on the site",
    "'Are they open now' is one of the most common pre-call questions.",
    "Publish hours in the footer and in the schema.", "30 minutes");
  if (!htmlPages.some(p => p.hasMap)) add("local", 25, "No map embed",
    "A map answers 'can I get there' faster than an address alone.",
    "Embed a Google map on the contact page.", "30 minutes");
  if (!htmlPages.some(p => p.hasForm)) add("local", 40, "No contact form on any crawled page",
    "Some people will never call; without a form they leave with no way to reach you.",
    "Add a short quote form: name, phone, what they need. Three fields, not ten.", "2 hours");
  if (!schemaTypes.some(t => /Review|AggregateRating/i.test(t)) && rating)
    add("local", 30, "Reviews are not marked up for search",
      "The stars only show in results when the page publishes review markup.",
      "Add AggregateRating schema reflecting the real Google rating.", "1 hour");

  // trust
  if (staleCopyright) add("trust", 45, `The footer says © ${staleCopyright}`,
    "A years-old copyright line tells visitors nobody is home.",
    "Update it, or generate the year automatically.", "15 minutes");
  if (!site.analytics) add("trust", 48, "No analytics installed",
    "Nobody is measuring what visitors do, so every marketing decision is a guess.",
    "Install GA4 and wire call clicks and form submits as conversions.", "1 hour");
  if (!site.ogTitle) add("trust", 32, "No social preview tags",
    "Shared links show up bare on Facebook, iMessage and WhatsApp, with no image and no pitch.",
    "Add Open Graph title, description and a real photo.", "1 hour");
  if (!site.favicon) add("trust", 20, "No favicon",
    "The browser-tab icon is small trust; a blank one reads unfinished.",
    "Add a favicon from the logo.", "15 minutes");
  if (lh.ok && lh.a11y < 80) add("trust", 40, `Accessibility scores ${lh.a11y}/100`,
    "Beyond the legal exposure, the same problems hurt older customers on phones.",
    "Fix contrast, form labels and link names first, since they are most of the score.", "half a day",
    (lh.failures || []).slice(0, 6).map(f => f.title));
  if (lh.ok && lh.consoleErrors) add("trust", 25, "The page logs JavaScript errors in the browser console",
    "Errors often mean a broken form, gallery or tracker that nobody has noticed.",
    "Open the console, fix what is throwing, re-test the forms.", "2 hours");
  if (noViewport.length) add("trust", 100, `${noViewport.length} page${noViewport.length > 1 ? "s do" : " does"} not work on phones`,
    "Most local searches happen on a phone. A page with no mobile layout loses the visitor in the first five seconds.",
    "Add the viewport meta and make the template mobile-first.", "1-2 days",
    noViewport.slice(0, 6).map(p => p.path));

  F.sort((a, b) => b.w - a.w);
  const sev = w => w >= 85 ? "critical" : w >= 65 ? "high" : w >= 45 ? "medium" : "low";
  const findings = F.map(f => ({ ...f, sev: sev(f.w) }));
  const scores = scoreOf(findings, lh);

  const data = {
    pro: true, name, url: base, town, date: new Date().toISOString().slice(0, 10),
    rating, reviews, gphone, slug, outDir, maxPages,
    lighthouse: lh, lighthouseDesktop: lhDesktop, tech, scores,
    site: { ...site, https, hasLocalSchema, altPct, schemaTypes, text: undefined },
    robots: robotsOk ? { ...robots, raw: robotsRes.text.slice(0, 2000) } : null,
    sitemap: { found: sitemap.found, count: sitemap.urls.length, sources: sitemap.sources, indexed: sitemap.indexed },
    crawl: {
      pages: htmlPages.map(({ text, headings, ...p }) => p),
      pagesCrawled: crawl.pages.length, discovered: crawl.queuedTotal,
      skippedByRobots: crawl.skippedByRobots,
      internalLinksFound: crawl.internalLinks.size, externalLinksFound: crawl.externalLinks.size,
      linksChecked: checkedCount,
    },
    links: { broken: [...brokenInternal, ...brokenExternal], blocked: blockedLinks,
             brokenInternal: brokenInternal.length, brokenExternal: brokenExternal.length },
    content: {
      totals: { pages: htmlPages.length, words: htmlPages.reduce((a, p) => a + (p.wordCount || 0), 0), images: imgTotal, altPct },
      noTitle: noTitle.map(p => p.path), dupTitles, noMeta: noMeta.map(p => p.path), dupMetas,
      noH1: noH1.map(p => p.path), thin: thin.map(p => ({ path: p.path, words: p.wordCount })),
      orphans, noindexed: noindexed.map(p => p.path), townCoverage,
    },
    local: { phones: [...allPhones].map(pretty), napMismatch, napSplit, telPages: telPages.length,
             hasAddress: site.addressish || htmlPages.some(p => p.addressish),
             hasHours: htmlPages.some(p => p.hoursish), hasMap: htmlPages.some(p => p.hasMap),
             hasForm: htmlPages.some(p => p.hasForm), schemaTypes },
    competitors: comps,
    findings,
    fixes: findings.slice(0, 5),
  };
  writeFileSync(join(outDir, "audit-pro.json"), JSON.stringify(data, null, 2));
  return data;
}
