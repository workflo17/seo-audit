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
import { gunzipSync } from "node:zlib";
import { ROOT, mine, keywords, measureLighthouse, decode, attr } from "./lib.mjs";
import { renderDom, renderAvailable } from "./render.mjs";
import { extractSchema } from "./schema.mjs";
import { lighthouseDetail } from "./lhdetail.mjs";
import { previousRun, diffRuns } from "./history.mjs";
import { readability, keywordStuffing, nearDuplicates, boilerplateRatio, placeholderText, ctaAboveFold,
         anchorQuality, headingOutline, titleH1Match } from "./textstats.mjs";
import { tlsInfo } from "./tlscheck.mjs";
import { compare, competitiveFinding } from "./compete.mjs";
import { discoverCompetitors, hostOf } from "./discover.mjs";

// A site owner who sees this in their logs can find out who was crawling and why.
export const UA = "Mozilla/5.0 (compatible; WorkfloAuditBot/1.0; +https://workflohq.com)";
const NULLDEV = process.platform === "win32" ? "NUL" : "/dev/null";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- fetching ----------
// Node fetch first, curl --ssl-no-revoke as the fallback (AVG intercepts TLS on this box).
// ttfbMs is the time until response headers arrived, measured before the body is read,
// so the crawl no longer needs a second curl request per page just to time the server.
// Decode the body with the charset the server or the page declares. Node's text() assumes
// UTF-8, which turns a windows-1252 page's apostrophes and dashes into mojibake in the PDF.
function decodeBody(buf, contentType) {
  let cs = (String(contentType || "").match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!cs) cs = (buf.subarray(0, 4096).toString("latin1").match(/<meta[^>]+charset=["']?\s*([\w-]+)/i) || [])[1];
  try { return new TextDecoder((cs || "utf-8").toLowerCase()).decode(buf); } catch { return buf.toString("utf8"); }
}
async function fetchOnce(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
    const ttfbMs = Date.now() - t0;
    const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
    const text = r.ok ? decodeBody(buf, r.headers.get("content-type")) : "";
    return { ok: r.ok, status: r.status, finalUrl: r.url, text, ms: Date.now() - t0, ttfbMs,
             bytes: buf.length, headers: Object.fromEntries(r.headers), transport: "fetch" };
  } catch {
    try {
      // The status code rides at the end of the body so a 404 page is not mistaken for a
      // live one just because it had some HTML in it.
      const raw = execFileSync("curl", ["-sL", "--ssl-no-revoke", "--max-time", "20", "-A", UA, "-w", "\nCURLSTATUS:%{http_code}\nCURLURL:%{url_effective}", url],
        { encoding: "utf8", maxBuffer: 30e6, stdio: ["ignore", "pipe", "pipe"] });
      const status = +((raw.match(/\nCURLSTATUS:(\d{3})/) || [])[1] || 0);
      const finalUrl = (raw.match(/\nCURLURL:(\S+)/) || [])[1] || url;
      const text = raw.replace(/\nCURLSTATUS:[\s\S]*$/, "");
      const ok = status >= 200 && status < 300 && text.length > 0;
      return { ok, status, finalUrl, text: ok ? text : "", ms: Date.now() - t0, ttfbMs: null,
               bytes: Buffer.byteLength(text), headers: {}, transport: "curl" };
    } catch { return { ok: false, status: 0, finalUrl: url, text: "", ms: Date.now() - t0, ttfbMs: null, bytes: 0, headers: {}, transport: "none" }; }
  }
}
// One retry on the failures that are usually the network's fault, not the site's: no
// answer at all, or a 5xx. A 4xx is the site's answer and is taken at face value.
export async function fetchPage(url) {
  const first = await fetchOnce(url);
  if (first.ok || (first.status >= 400 && first.status < 500)) return first;
  await sleep(400);
  const second = await fetchOnce(url);
  return { ...second, retried: true };
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
const clean = s => decode(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

const tagsOf = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(m => m[0]);
const abs = (raw, base) => { try { const u = new URL(raw, base); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };

export function mineDeep(html, url) {
  const base = mine(html);
  const stripBlocks = (s, names) => names.reduce((acc, n) => acc.replace(new RegExp(`<${n}\\b[\\s\\S]*?<\\/${n}>`, "gi"), " "), s);
  // Only what a reader sees counts as copy: no head, scripts, styles, menus, footers,
  // noscript fallbacks, inline SVG or templates. Header stays because the H1 often lives there.
  const body = stripBlocks(html, ["head", "script", "style", "nav", "footer", "noscript", "template", "svg", "select"]);
  const bodyText = clean(body);
  const wordCount = (bodyText.match(/[A-Za-z][A-Za-z'’-]{1,}/g) || []).length;
  const pageText = clean(stripBlocks(html, ["head", "script", "style", "noscript", "template", "svg"]));
  // Tags are read from the markup with scripts removed, so an <a> or <img> sitting inside
  // a JavaScript string does not count as a link on the page (it is not one until it runs).
  const markup = stripBlocks(html, ["script", "style", "noscript", "template"]);

  const linkTags = tagsOf(html, "link");
  const metaTags = tagsOf(html, "meta");
  const relIs = (t, v) => (attr(t, "rel") || "").toLowerCase().split(/\s+/).includes(v);
  const canonicalTag = linkTags.find(t => relIs(t, "canonical"));
  const canonicalHref = canonicalTag ? abs(attr(canonicalTag, "href") || "", url) : null;
  const metaNamed = n => metaTags.filter(t => (attr(t, "name") || attr(t, "property") || "").toLowerCase() === n).map(t => attr(t, "content") || "");
  // Both robots and googlebot metas count, whatever order their attributes come in.
  const robotsMeta = [...metaNamed("robots"), ...metaNamed("googlebot")].join(",").toLowerCase();
  const lang = attr((html.match(/<html\b[^>]*>/i) || [""])[0], "lang");
  const ogImage = abs(metaNamed("og:image")[0] || "", url);
  const metaRefresh = metaTags.some(t => (attr(t, "http-equiv") || "").toLowerCase() === "refresh");

  const headings = [...markup.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map(m => ({ lvl: +m[1], text: clean(m[2]).slice(0, 120) }));

  // Mixed content means insecure ASSETS on a secure page: images, scripts, frames,
  // stylesheets. An ordinary <a href="http://..."> link is not an asset and is not counted.
  const assetUrls = [
    ...[...html.matchAll(/<(?:img|script|iframe|source|video|audio|embed)\b[^>]*\ssrc\s*=\s*["']?([^"'\s>]+)/gi)].map(m => m[1]),
    ...linkTags.filter(t => relIs(t, "stylesheet") || relIs(t, "icon") || relIs(t, "preload")).map(t => attr(t, "href") || ""),
  ];
  const mixed = [...new Set(assetUrls.filter(u => /^http:\/\//i.test(u) && !/^http:\/\/(localhost|127\.)/.test(u)))];

  let host = null; try { host = new URL(url).host; } catch {}
  const links = [], anchors = [];
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = "<a" + m[1] + ">";
    const raw = attr(tag, "href");
    if (!raw) continue;
    const text = clean(m[2]) || (attr(tag, "aria-label") || attr(tag, "title") || "").trim();
    anchors.push({ text: text.slice(0, 80), href: raw.slice(0, 200) });
    if (/^(mailto|tel|javascript|sms):/i.test(raw) || raw.startsWith("#")) continue;
    const href = abs(raw, url);
    if (!href) continue;
    const u = new URL(href); u.hash = "";
    links.push({ href: u.href, internal: u.host === host, text: text.slice(0, 80), nofollow: /\bnofollow\b/i.test(attr(tag, "rel") || "") });
  }
  const imgTags = tagsOf(markup, "img");
  const imgSrcs = [...new Set(imgTags.map(t => abs(attr(t, "src") || attr(t, "data-src") || "", url)).filter(Boolean))].slice(0, 60);
  const imgsUnsized = imgTags.filter(t => !attr(t, "width") || !attr(t, "height")).length;
  const emails = [...new Set([...markup.matchAll(/href=["']?mailto:([^"'?\s>]+)/gi)].map(m => m[1].toLowerCase()))];

  // Local-presence signals a person would recognise on the page.
  const hasMapEmbed = /<iframe\b[^>]*src\s*=\s*["']?[^"'>]*(google\.com\/maps|maps\.google|mapbox|openstreetmap)/i.test(html);
  const hasMapLink = links.some(l => /google\.com\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.apple\.com|waze\.com/i.test(l.href));
  const profileOf = re => links.filter(l => re.test(l.href)).map(l => l.href);
  const profiles = {
    google: profileOf(/g\.page\/|google\.com\/maps\/place|business\.google\.com|search\.google\.com\/local/i),
    yelp: profileOf(/yelp\.com/i), facebook: profileOf(/facebook\.com/i), instagram: profileOf(/instagram\.com/i),
    houzz: profileOf(/houzz\.com/i), angi: profileOf(/angi\.com|angieslist\.com|homeadvisor\.com/i),
    bbb: profileOf(/bbb\.org/i), nextdoor: profileOf(/nextdoor\.com/i), thumbtack: profileOf(/thumbtack\.com/i),
    linkedin: profileOf(/linkedin\.com/i), youtube: profileOf(/youtube\.com|youtu\.be/i),
  };
  const forms = tagsOf(html, "form").length;
  const inputs = [...html.matchAll(/<(?:input|textarea|select)\b[^>]*>/gi)].map(m => m[0]).filter(t => !/type\s*=\s*["']?(hidden|submit|button)/i.test(t));
  const labels = tagsOf(html, "label").length;
  const hasForm = forms > 0 && inputs.length > 0;
  const addressish = /\b\d{1,6}\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)?\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|hwy|highway|pkwy|parkway|pl|place|ct|court|ste|suite|floor|fl)\b\.?/i.test(pageText);
  const zip = (pageText.match(/\b(?:NY|NJ|CT|PA|[A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/) || [])[1] || null;
  const hoursish = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*(?:–|-|to|:|through)/i.test(pageText) && /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(pageText);
  const licenseMention = /\b(licen[cs]ed|licen[cs]e\s*(?:#|no\.?|number)|lic\.?\s*#|insured|bonded|HIC\s*#?|certified|EPA\s+lead)\b/i.test(pageText);
  const bookingSignals = [...new Set([
    ...(/\b(book (now|online|an appointment)|schedule (now|online|a visit|an appointment)|request an? (appointment|estimate|quote)|get a (free )?(quote|estimate)|reserve a table|order online|make a reservation)\b/i.test(pageText) ? ["cta-text"] : []),
    ...links.filter(l => /calendly\.com|acuityscheduling|squareup\.com\/appointments|booksy|zocdoc|opentable|resy\.com|toasttab|doordash|ubereats|grubhub|housecallpro|jobber|servicetitan/i.test(l.href)).map(() => "booking-link"),
  ])];
  const pdfMenu = links.some(l => /\.pdf(\?|$)/i.test(l.href) && /menu/i.test(l.href + " " + (l.text || "")));

  return { ...base, wordCount, canonicalHref, robotsMeta, noindex: /noindex/i.test(robotsMeta),
           nofollowMeta: /nofollow/i.test(robotsMeta), metaRefresh, lang: lang ? lang.trim() : null, ogImage,
           headings, mixed, links, anchors, imgSrcs, imgsUnsized, emails,
           hasMap: hasMapEmbed || hasMapLink, hasMapEmbed, hasMapLink, profiles, forms, formInputs: inputs.length, formLabels: labels, hasForm,
           addressish, zip, hoursish, licenseMention, bookingSignals, pdfMenu,
           text: bodyText.slice(0, 20000), html };
}

// ---------- robots.txt + sitemaps ----------
export function parseRobots(text) {
  const sitemaps = [], groups = [];
  let current = null, lastWasUa = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) { lastWasUa = false; continue; }
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase(), val = line.slice(i + 1).trim();
    if (key === "sitemap") { if (val) sitemaps.push(val); continue; }
    if (key === "user-agent") {
      // Consecutive User-agent lines form ONE group (the spec's stacked form); a blank
      // line or a rule ends the run, so the next User-agent starts a new group.
      if (lastWasUa && current) current.uas.push(val.toLowerCase());
      else { current = { uas: [val.toLowerCase()], disallow: [], allow: [] }; groups.push(current); }
      lastWasUa = true; continue;
    }
    lastWasUa = false;
    if (!current) continue;
    if (key === "disallow" && val) current.disallow.push(val);
    else if (key === "allow" && val) current.allow.push(val);
  }
  // Googlebot obeys its own group when there is one and ignores * entirely; the audit
  // mirrors that, since Google is the crawler the client is paying to be found by.
  const pick = name => groups.find(g => g.uas.includes(name));
  const g = pick("googlebot") || pick("*") || { disallow: [], allow: [] };
  const star = pick("*") || { disallow: [], allow: [] };
  return { sitemaps, groups, disallow: g.disallow, allow: g.allow, appliedTo: pick("googlebot") ? "googlebot" : "*",
           starDisallow: star.disallow, googlebotBlocked: !!pick("googlebot") && g.disallow.includes("/") };
}
// robots patterns: * matches anything, $ anchors the end, otherwise a path prefix.
function robotsMatch(pattern, pathname) {
  let re = pattern.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  if (re.endsWith("\\$")) re = re.slice(0, -2) + "$";
  try { return new RegExp("^" + re).test(pathname); } catch { return pathname.startsWith(pattern); }
}
// The most specific (longest) matching rule wins; an Allow of equal length beats a Disallow.
const blockedBy = (pathname, disallow, allow = []) => {
  const d = disallow.filter(p => robotsMatch(p, pathname)).sort((a, b) => b.length - a.length)[0];
  if (!d) return null;
  const a = allow.filter(p => robotsMatch(p, pathname)).sort((a, b) => b.length - a.length)[0];
  return a && a.length >= d.length ? null : d;
};

// Sitemaps arrive as plain XML or gzip, with <loc> sometimes wrapped in CDATA.
async function fetchXml(url) {
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    let buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = gunzipSync(buf); } catch { return null; } }
    return buf.toString("utf8");
  } catch {
    const r = await fetchPage(url);
    return r.ok ? r.text : null;
  }
}
const locsOf = xml => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map(m => decode(m[1]));
const lastmodValid = xml => { const all = [...xml.matchAll(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/gi)].map(m => m[1]); return { count: all.length, invalid: all.filter(v => isNaN(Date.parse(v))).length }; };

export async function readSitemaps(origin, robots) {
  const candidates = [...new Set([...(robots?.sitemaps || []), origin + "/sitemap.xml", origin + "/sitemap_index.xml", origin + "/sitemap.xml.gz"])];
  const urls = new Set();
  const sources = [];
  let indexed = 0;
  const host = new URL(origin).host.replace(/^www\./, "");
  for (const sm of candidates.slice(0, 6)) {
    const xml = await fetchXml(sm);
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) { sources.push({ url: sm, ok: false }); continue; }
    const locs = locsOf(xml);
    const lm = lastmodValid(xml);
    if (/<sitemapindex/i.test(xml)) {
      indexed++;
      sources.push({ url: sm, ok: true, index: true, children: locs.length, lastmods: lm.count, lastmodInvalid: lm.invalid });
      for (const child of locs.slice(0, 12)) {
        const cx = await fetchXml(child);
        if (!cx) { sources.push({ url: child, ok: false, child: true }); continue; }
        const cl = locsOf(cx);
        const clm = lastmodValid(cx);
        sources.push({ url: child, ok: true, index: false, child: true, count: cl.length, lastmods: clm.count, lastmodInvalid: clm.invalid });
        for (const l of cl) if (urls.size < 5000) urls.add(l);
      }
    } else {
      sources.push({ url: sm, ok: true, index: false, count: locs.length, lastmods: lm.count, lastmodInvalid: lm.invalid });
      for (const l of locs) if (urls.size < 5000) urls.add(l);
    }
  }
  const offHost = [...urls].filter(u => { try { return new URL(u).host.replace(/^www\./, "") !== host; } catch { return true; } });
  return { found: sources.some(s => s.ok), sources, urls: [...urls], indexed, offHost,
           declaredInRobots: (robots?.sitemaps || []).length > 0 };
}

// ---------- crawl ----------
const skipExt = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|docx?|xlsx?|pptx?|mp[34]|mov|avi|css|js|json|xml|txt)$/i;
const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_ga|ref|source)$/i;
// One key per page whatever the URL spelling: scheme, www, trailing slash, index file,
// path case and tracking parameters are all noise; real query strings are kept.
export const canonicalKey = u => {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (TRACKING.test(k)) x.searchParams.delete(k);
    x.searchParams.sort();
    const path = x.pathname.replace(/\/(index|default|home)\.(html?|php|aspx?)$/i, "/").replace(/\/+$/, "");
    const q = x.searchParams.toString();
    return (x.host.replace(/^www\./, "") + path + (q ? "?" + q : "")).toLowerCase();
  } catch { return String(u).replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/, "").toLowerCase(); }
};

// A page that comes back with almost no words but carries a script is usually a
// JavaScript shell, not an empty page: the menu is in the HTML and the content is not.
// When a `render` function is supplied (see render.mjs) such pages are fetched again
// through a real browser and re-mined. Costs about a second and a half per page.
const looksUnrendered = m => m.wordCount < 40 && /<script\b/i.test(m.html || "");

export async function deepCrawl({ base, seeds = [], maxPages = 40, concurrency = 4, disallow = [], allow = [], budgetMs = 240000,
                                  render = null, stage = () => {} }) {
  const host = new URL(base).host;
  const apex = host.replace(/^www\./, "");
  const seedSet = new Set(seeds.map(canonicalKey));
  const started = Date.now();
  // Dedupe the seed list up front: the sitemap almost always repeats the homepage the
  // crawl already starts from, and "site.com" / "site.com/" are the same page.
  const queue = [];
  const queued = new Set();
  const depthOf = new Map();      // canonical key -> clicks from the homepage (null = only known from the sitemap)
  for (const u of [base, ...seeds]) {
    try { if (new URL(u).host !== host) continue; } catch { continue; }
    const key = canonicalKey(u);
    if (queued.has(key)) continue;
    queued.add(key); queue.push(u);
    depthOf.set(key, u === base ? 0 : null);
  }
  const pages = [];
  const inbound = new Map();      // canonical key -> how many internal links point at it
  const externalLinks = new Map(); // href -> first page that linked to it
  const internalLinks = new Map(); // href -> first page that linked to it
  const skippedByRobots = [];
  let cursor = 0, rendered = 0, truncatedByTime = false;

  async function worker() {
    while (cursor < queue.length && pages.length < maxPages) {
      if (Date.now() - started > budgetMs) { truncatedByTime = true; return; }
      const url = queue[cursor++];
      if (!url) continue;
      let pathname = "/";
      try { pathname = new URL(url).pathname; } catch {}
      const block = blockedBy(pathname, disallow, allow);
      if (block && url !== base) { skippedByRobots.push({ url, rule: block }); continue; }
      const key = canonicalKey(url);
      const depth = depthOf.has(key) ? depthOf.get(key) : null;
      const r = await fetchPage(url);
      const finalKey = canonicalKey(r.finalUrl || url);
      let finalHost = host; try { finalHost = new URL(r.finalUrl || url).host; } catch {}
      const rec = { url, status: r.status, ms: r.ms, ttfbMs: r.ttfbMs, bytes: r.bytes, ok: r.ok, depth, retried: !!r.retried,
                    inSitemap: seedSet.has(key), xRobots: r.headers["x-robots-tag"] || null,
                    redirectedTo: finalKey !== key ? (r.finalUrl || url) : null };
      // A redirect off the client's host is someone else's page: note it, do not mine it.
      if (finalHost.replace(/^www\./, "") !== apex) { rec.offHost = true; pages.push(rec); continue; }
      // A redirect onto a page already crawled is a duplicate URL, not a second page.
      if (rec.redirectedTo && queued.has(finalKey) && finalKey !== key) { rec.duplicateOf = finalKey; queued.add(finalKey); pages.push(rec); continue; }
      if (rec.redirectedTo) queued.add(finalKey);
      if (r.ok && /html/i.test(r.headers["content-type"] || "text/html")) {
        let m = mineDeep(r.text, r.finalUrl || url);
        if (render && looksUnrendered(m)) {
          const html = await render(r.finalUrl || url);
          if (html) { m = mineDeep(html, r.finalUrl || url); rec.rendered = true; rendered++; }
        }
        // Everything mineDeep saw rides on the record; the heavy fields (html, text,
        // links, anchors) are stripped before the JSON is written.
        Object.assign(rec, m, {
          path: (() => { try { return new URL(r.finalUrl || url).pathname || "/"; } catch { return url; } })(),
          titleLen: m.title ? m.title.length : 0, metaLen: m.metaDesc ? m.metaDesc.length : 0,
          internalOut: m.links.filter(l => l.internal).length, externalOut: m.links.filter(l => !l.internal).length,
        });
        const childDepth = depth === null ? null : depth + 1;
        for (const l of m.links) {
          if (l.internal) {
            const k = canonicalKey(l.href);
            inbound.set(k, (inbound.get(k) || 0) + 1);
            if (!internalLinks.has(l.href)) internalLinks.set(l.href, url);
            // Keep the shortest click path seen for every page, including sitemap seeds
            // whose depth was unknown until a link to them turned up.
            if (childDepth !== null && (depthOf.get(k) === null || depthOf.get(k) === undefined || depthOf.get(k) > childDepth)) depthOf.set(k, childDepth);
            if (!queued.has(k) && !skipExt.test(new URL(l.href).pathname) && queue.length < maxPages * 4) {
              queued.add(k); queue.push(l.href);
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
  // Depths settle only after the whole crawl: a page fetched early from the sitemap may
  // have been linked from a page fetched later.
  for (const p of pages) { const d = depthOf.get(canonicalKey(p.url)); p.depth = d === undefined ? null : d; }
  return { pages, inbound, internalLinks, externalLinks, skippedByRobots, queuedTotal: queued.size,
           rendered, truncatedByTime, elapsedMs: Date.now() - started };
}

// ---------- link checking ----------
async function linkStatusOnce(url) {
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
// A link is only called dead after two tries: one timeout on a busy host is not a 404.
async function linkStatus(url) {
  const s = await linkStatusOnce(url);
  if (s !== 0 && s < 500) return s;
  await sleep(500);
  return linkStatusOnce(url);
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
// Follows the redirect chain one hop at a time (up to four) so the ordinary
// http -> http://www -> https://www path is judged by where it ends, not by its first hop.
function landing(url, maxHops = 4) {
  let current = url, status = null;
  const chain = [];
  for (let hop = 0; hop <= maxHops; hop++) {
    const p = probe(current, { follow: false });
    if (!p.ok) return { ok: false, status: null, to: null, hops: hop, chain };
    status = p.status;
    if (p.status >= 300 && p.status < 400 && p.headers.location) {
      chain.push({ from: current, status: p.status });
      try { current = new URL(p.headers.location, current).href; continue; } catch { break; }
    }
    return { ok: true, status, to: p.status === 200 ? current.replace(/\/+$/, "").toLowerCase() : null, hops: chain.length, chain,
             temporary: chain.some(c => c.status === 302 || c.status === 307) };
  }
  return { ok: true, status, to: null, hops: chain.length, chain, loop: true };
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
  // Probe from the origin, not the landing page: a homepage that lives at /home/ would
  // otherwise turn this into /home/this-page..., which many servers answer differently.
  const missing = probe(u.origin + "/this-page-should-not-exist-" + Date.now().toString(36), { follow: false });
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
// A category that could not be measured scores null and its weight is shared out
// across the others, so the overall never carries an invented number. Two cases:
// speed when Lighthouse failed (its rules cannot fire, so the decay formula would
// print 100 for a site nobody timed), and local for a site that is not a local business.
function scoreOf(findings, lhMobile, { siteType = "local" } = {}) {
  const scores = {}, notes = [];
  const active = Object.keys(CATS).filter(c => !(c === "local" && siteType !== "local") && !(c === "speed" && !lhMobile.ok));
  for (const cat of Object.keys(CATS)) {
    if (!active.includes(cat)) { scores[cat] = null; continue; }
    const hit = findings.filter(f => f.cat === cat).reduce((a, f) => a + f.w, 0);
    // Diminishing returns rather than a straight subtraction, so a site with eight
    // problems still scores below one with three instead of both flooring at zero.
    scores[cat] = Math.max(0, Math.round(100 * Math.exp(-hit / 220)));
  }
  // Speed is measured, not inferred: Lighthouse owns that number when it ran.
  if (lhMobile.ok) scores.speed = lhMobile.perf;
  else notes.push("Lighthouse did not run, so speed was not scored and its weight moved to the other categories.");
  if (siteType !== "local") notes.push("Local presence is not scored for this kind of site.");
  const totalW = active.reduce((a, c) => a + CATS[c], 0);
  const weights = Object.fromEntries(Object.keys(CATS).map(c => [c, active.includes(c) ? Math.round(CATS[c] / totalW * 1000) / 10 : 0]));
  const overall = Math.round(active.reduce((a, c) => a + scores[c] * CATS[c], 0) / totalW);
  return { ...scores, overall, weights, notes };
}

// ---------- the pro audit ----------
const norm = p => (p || "").replace(/\D/g, "").slice(-10);
const pretty = p => String(p).replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");

// Homepage-only head-to-head, run identically on the target and each competitor so the
// comparison table compares like with like: one Lighthouse mobile pass plus the basics
// a prospect understands (secure, mobile, schema, tap-to-call, described, measured).
async function quickScorecard(url, lhPath, stage) {
  const r = await fetchPage(url);
  if (!r.ok) return { url, ok: false };
  const m = mineDeep(r.text, r.finalUrl || url);
  const p = probe(r.finalUrl || url);
  stage(`Lighthouse on ${new URL(r.finalUrl || url).host}…`);
  const lh = measureLighthouse(r.finalUrl || url, lhPath);
  return {
    url: r.finalUrl || url, ok: true, title: m.title, titleLen: m.title ? m.title.length : 0, metaDesc: !!m.metaDesc,
    words: m.wordCount, https: (r.finalUrl || url).startsWith("https:"), viewport: m.viewport,
    schema: m.ldTypes, hasLocalSchema: m.ldTypes.some(t => /LocalBusiness|Organization|Business|Store|Restaurant|Dentist|Service/i.test(t)),
    telLink: m.tels.length > 0, analytics: m.analytics, ogTitle: m.ogTitle,
    altPct: m.imgCount ? Math.round(m.imgsWithAlt / m.imgCount * 100) : 100,
    ttfbMs: p.ok ? p.ttfbMs : r.ttfbMs, httpVersion: p.ok ? p.httpVersion : null,
    compressed: p.ok ? /gzip|br|deflate|zstd/i.test(p.headers["content-encoding"] || "") : null,
    lh: lh.ok ? { perf: lh.perf, seo: lh.seo, a11y: lh.a11y, bp: lh.bp, lcp: lh.lcp?.v || null, cls: lh.cls?.v || null } : null,
    text: m.text, h1s: m.h1s,
  };
}

export async function runProAudit(opts, stage = () => {}) {
  const { name, url, gphone, town, rating, reviews } = opts;
  const competitors = (opts.competitors || [opts.competitor]).filter(Boolean);
  const maxPages = Math.max(5, Math.min(200, +opts.maxPages || 40));
  // "local" applies the local-presence rules and scores that category; anything else
  // (a portfolio, a fund, a SaaS) skips them so it is not marked down for having no
  // opening hours. Explicit rather than guessed: a local business with no phone on its
  // site is exactly the finding the local rules exist to raise.
  const siteType = /^(general|other|nonlocal|national)$/i.test(opts.type || "") ? "general" : "local";
  const lhPages = Math.max(0, Math.min(5, opts.lhPages === undefined || opts.lhPages === null || opts.lhPages === "" ? 2 : +opts.lhPages));
  const budgetMs = Math.max(30000, +opts.crawlBudgetMs || 240000);
  // Pages that arrive as an empty JavaScript shell are re-read through headless Edge
  // unless the caller switches that off (opts.render === false).
  const render = opts.render === false ? null : typeof opts.render === "function" ? opts.render : (renderAvailable() ? renderDom : null);
  const stamp = new Date().toISOString().slice(0, 16).replace(/:/g, "");
  const slug = (name || new URL(url).hostname).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const outDir = join(ROOT, "out", slug);
  mkdirSync(outDir, { recursive: true });

  stage("Fetching the homepage…");
  const home = await fetchPage(url);
  if (!home.ok) throw new Error("could not fetch " + url);
  const site = mineDeep(home.text, home.finalUrl || url);
  const base = (home.finalUrl || url).replace(/\/$/, "");
  const https = base.startsWith("https:");
  // robots.txt, sitemaps and the 404 probe live at the origin even when the homepage
  // redirected somewhere deeper.
  const origin = new URL(base).origin;

  stage("Reading robots.txt…");
  const robotsRes = await fetchPage(origin + "/robots.txt");
  const robotsOk = robotsRes.ok && /user-agent|disallow|sitemap/i.test(robotsRes.text) && !/<html/i.test(robotsRes.text);
  const robots = robotsOk ? parseRobots(robotsRes.text) : null;

  stage("Reading sitemaps…");
  const sitemap = await readSitemaps(origin, robots);

  stage(`Crawling the site, up to ${maxPages} pages…`);
  const crawl = await deepCrawl({ base, seeds: sitemap.urls.slice(0, maxPages), maxPages,
    disallow: robots?.disallow || [], allow: robots?.allow || [], budgetMs, render, stage });
  const htmlPages = crawl.pages.filter(p => p.ok && p.title !== undefined && !p.offHost && !p.duplicateOf);
  const crawlComplete = !crawl.truncatedByTime && crawl.pages.length < maxPages;
  if (crawl.truncatedByTime) stage(`Crawl stopped at the ${Math.round(budgetMs / 60000)}-minute budget with ${htmlPages.length} pages read.`);
  if (crawl.rendered) stage(`${crawl.rendered} page${crawl.rendered === 1 ? "" : "s"} needed a browser to render.`);

  stage("Checking every internal link…");
  const internalEntries = [...crawl.internalLinks].map(([u, from]) => ({ url: u, from, kind: "internal" }))
    .filter(e => !crawl.pages.some(p => canonicalKey(p.url) === canonicalKey(e.url) && p.ok));
  const externalEntries = [...crawl.externalLinks].map(([u, from]) => ({ url: u, from, kind: "external" })).slice(0, 60);
  // Images break as often as links and nobody notices until a customer does.
  const imageEntries = [];
  const seenImg = new Set();
  for (const p of htmlPages) for (const src of (p.imgSrcs || [])) {
    if (seenImg.has(src) || imageEntries.length >= 40) continue;
    seenImg.add(src); imageEntries.push({ url: src, from: p.url, kind: "image" });
  }
  const ogEntries = [...new Set(htmlPages.map(p => p.ogImage).filter(Boolean))].slice(0, 5).map(u => ({ url: u, from: "og:image", kind: "ogimage" }));
  const checkedCount = internalEntries.length + externalEntries.length + imageEntries.length + ogEntries.length;
  const badLinks = await checkLinks([...internalEntries, ...externalEntries, ...imageEntries, ...ogEntries], { stage });

  const tech = await techChecks(base, stage);
  // On a site that answers 200 for a missing page, a dead internal link looks alive to
  // every status check, including this one. Say so rather than print a false all-clear.
  const linksReliable = tech.notFoundStatus === null ? null : (tech.notFoundStatus === 404 || tech.notFoundStatus === 410);

  stage("Running Lighthouse on mobile, 60 to 120 seconds…");
  const lh = measureLighthouse(base, join(outDir, "lighthouse.json"));
  stage("Running Lighthouse on desktop, 60 to 120 seconds…");
  const lhDesktop = measureLighthouse(base, join(outDir, "lighthouse-desktop.json"), "--preset=desktop");

  // The homepage is rarely the slowest page. Measure the inner pages the site itself
  // points at most (they are the service pages that take the search traffic).
  const innerCandidates = htmlPages
    .filter(p => canonicalKey(p.url) !== canonicalKey(base))
    .map(p => ({ p, inbound: crawl.inbound.get(canonicalKey(p.url)) || 0 }))
    // Menu pages all tie on inbound links; the one with the most copy is the service page.
    .sort((a, b) => b.inbound - a.inbound || (b.p.wordCount || 0) - (a.p.wordCount || 0))
    .slice(0, lhPages);
  const lighthousePages = [];
  for (const [i, { p }] of innerCandidates.entries()) {
    stage(`Lighthouse on ${p.path} (${i + 1} of ${innerCandidates.length})…`);
    const file = join(outDir, `lighthouse-page${i + 1}.json`);
    const r = measureLighthouse(p.url, file);
    lighthousePages.push({ path: p.path, url: p.url, ok: r.ok, perf: r.ok ? r.perf : null, seo: r.ok ? r.seo : null,
      a11y: r.ok ? r.a11y : null, lcp: r.ok ? r.lcp?.v : null, cls: r.ok ? r.cls?.v : null, tbt: r.ok ? r.tbt?.v : null,
      opportunities: r.ok ? r.opportunities.slice(0, 3) : [] });
  }

  // Competitors found the way a customer finds them: a search for what the site says it does
  // plus where it is, filling the list up to three when the run asks for it.
  let discovery = null;
  if (opts.findCompetitors && competitors.length < 3) {
    stage("Searching for competitors…");
    discovery = await discoverCompetitors({ url: base, name, town, title: site.title, h1s: site.h1s, metaDesc: site.metaDesc,
      html: home.text, exclude: competitors, want: 3 - competitors.length });
    stage(discovery.picked.length ? `Found ${discovery.picked.map(hostOf).join(", ")} by searching for "${discovery.queries[0]}".` : discovery.note);
    competitors.push(...discovery.picked);
  }
  const comps = [];
  let selfCard = null;
  if (competitors.length) {
    stage("Scoring this site's homepage for the head-to-head…");
    selfCard = await quickScorecard(base, join(outDir, "lighthouse-self.json"), stage);
  }
  for (const [i, c] of competitors.slice(0, 3).entries()) {
    stage(`Reading competitor ${i + 1}…`);
    const found = !!discovery && discovery.picked.includes(c);
    const card = await quickScorecard(c, join(outDir, `lighthouse-competitor${i + 1}.json`), stage);
    if (!card.ok) { comps.push({ url: c, ok: false, found }); continue; }
    const mineKw = new Set(keywords([site.title, site.metaDesc, ...site.h1s, site.text].join(" ")));
    const gap = keywords([card.title, ...card.h1s, card.text].join(" ")).filter(w => !mineKw.has(w)).slice(0, 12);
    const { text, h1s, ...rest } = card;
    comps.push({ ...rest, gap, found });
  }
  if (selfCard) { const { text, h1s, ...rest } = selfCard; selfCard = rest; }
  // Rows, the measures this site is behind on, and what closes each gap; see compete.mjs.
  const headToHead = selfCard ? { self: selfCard, competitors: comps.filter(c => c.ok), discovery, ...compare(selfCard, comps, { siteType }) } : null;

  stage("Scoring the findings…");
  // ---- aggregates the rules read from ----
  const gph = norm(gphone);
  // Template placeholder numbers are a finding of their own, not a second business line.
  const PLACEHOLDER_PHONES = new Set(["5555555555", "0000000000", "1234567890", "5551234567", "1112223333"]);
  const allPhones = new Set(htmlPages.flatMap(p => [...(p.phones || []), ...(p.tels || []).map(norm)]).filter(n => n && !PLACEHOLDER_PHONES.has(n)));
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
  // An orphan is a live page of this site that nothing links to. Dead sitemap entries and
  // other hosts' URLs are sitemap hygiene problems, reported separately.
  const deadSitemapKeys = new Set(crawl.pages.filter(p => p.status >= 400).map(p => canonicalKey(p.url)));
  const orphans = sitemap.urls.filter(u => {
    const key = canonicalKey(u);
    if (sitemap.offHost.includes(u) || deadSitemapKeys.has(key)) return false;
    return key !== canonicalKey(base) && !crawl.inbound.get(key);
  }).slice(0, 25);
  // 401/403/429 usually means the far end blocks bots rather than a dead link, so
  // these are listed for review instead of counted as broken.
  const isBlocked = s => s === 401 || s === 403 || s === 429;
  const blockedLinks = badLinks.filter(l => isBlocked(l.status));
  const brokenInternal = badLinks.filter(l => l.kind === "internal" && !isBlocked(l.status));
  const brokenExternal = badLinks.filter(l => l.kind === "external" && !isBlocked(l.status));
  const brokenImages = badLinks.filter(l => l.kind === "image" && !isBlocked(l.status));
  const brokenOg = badLinks.filter(l => l.kind === "ogimage" && !isBlocked(l.status));
  // Per-page indexability the way Search Console reports it: one verdict, one reason.
  for (const p of htmlPages) {
    const canon = p.canonicalHref ? canonicalKey(p.canonicalHref) : null;
    p.canonicalElsewhere = !!(canon && canon !== canonicalKey(p.url));
    p.canonicalOffHost = !!(p.canonicalHref && (() => { try { return new URL(p.canonicalHref).host.replace(/^www\./, "") !== new URL(base).host.replace(/^www\./, ""); } catch { return false; } })());
    const xr = String(p.xRobots || "").toLowerCase();
    if (p.status && p.status !== 200) { p.indexable = false; p.indexReason = `returns HTTP ${p.status}`; }
    else if (p.noindex) { p.indexable = false; p.indexReason = "noindex meta tag"; }
    else if (/noindex/.test(xr)) { p.indexable = false; p.indexReason = "noindex in X-Robots-Tag header"; }
    else if (p.canonicalOffHost) { p.indexable = false; p.indexReason = "canonical points to another site"; }
    else if (p.canonicalElsewhere) { p.indexable = false; p.indexReason = "canonical points to a different page"; }
    else if (p.metaRefresh) { p.indexable = false; p.indexReason = "meta refresh redirect"; }
    else { p.indexable = true; p.indexReason = p.inSitemap ? "indexable, in sitemap" : "indexable, not in sitemap"; }
  }
  const xRobotsNoindex = htmlPages.filter(p => /noindex/i.test(String(p.xRobots || "")) && !p.noindex);
  const canonOffHost = htmlPages.filter(p => p.canonicalOffHost);
  const canonElsewhere = htmlPages.filter(p => p.canonicalElsewhere && !p.canonicalOffHost);
  const redirectingLinks = crawl.pages.filter(p => p.redirectedTo && !p.offHost);
  const sitemapDead = crawl.pages.filter(p => p.inSitemap && p.status >= 400);
  const sitemapNoindex = htmlPages.filter(p => p.inSitemap && !p.indexable);
  const noLang = htmlPages.filter(p => !p.lang);
  const profilesFound = Object.fromEntries(Object.keys(htmlPages[0]?.profiles || {}).map(k => [k, [...new Set(htmlPages.flatMap(p => p.profiles?.[k] || []))]]));
  const hasGoogleProfile = (profilesFound.google || []).length > 0 || htmlPages.some(p => p.hasMapLink);
  const reviewPlatforms = ["yelp", "facebook", "houzz", "angi", "bbb", "thumbtack"].filter(k => (profilesFound[k] || []).length);
  const townPhrase = (town || "").split(",")[0].trim().toLowerCase();
  const namesTown = p => townPhrase.length >= 3 && [p.title, p.metaDesc, ...(p.h1s || []), p.text].some(s => (s || "").toLowerCase().includes(townPhrase));
  const homeNamesTownUpFront = townPhrase.length >= 3 && [site.title, ...(site.h1s || [])].some(s => (s || "").toLowerCase().includes(townPhrase));
  const sitemapMissingPages = htmlPages.filter(p => sitemap.found && !sitemap.urls.some(u => canonicalKey(u) === canonicalKey(p.url)));
  let hasLocalSchema = site.ldTypes.some(t => /LocalBusiness|Organization|HomeAndConstructionBusiness|Restaurant|Dentist|Store|ProfessionalService|Plumber|Electrician|Contractor/i.test(t));
  const schemaTypes = [...new Set(htmlPages.flatMap(p => p.ldTypes || []))];
  const telPages = htmlPages.filter(p => (p.tels || []).length);
  const year = new Date().getFullYear();
  const staleCopyright = site.copyrightYear && site.copyrightYear <= year - 2 ? site.copyrightYear : null;
  // The town is matched as a phrase ("Red Hook", not "hook") across title, H1, description
  // and body, so a page counts when it actually names the place a searcher typed.
  const townWords = townPhrase.length >= 3 ? [townPhrase] : [];
  const townCoverage = townWords.length ? htmlPages.filter(namesTown).length : null;

  // ---- structured data, read properly this time ----
  for (const p of htmlPages) p.schema = extractSchema(p.html || "", p.url);
  const homeSchema = extractSchema(home.text, base);
  const lb = homeSchema.localBusiness || htmlPages.map(p => p.schema.localBusiness).find(Boolean) || null;
  const schemaPhoneMismatch = !!(lb && lb.telephoneDigits && allPhones.size && !allPhones.has(lb.telephoneDigits));
  const schemaGoogleMismatch = !!(lb && lb.telephoneDigits && gph && lb.telephoneDigits !== gph);
  const selfServing = homeSchema.selfServingReviews || htmlPages.some(p => p.schema.selfServingReviews);
  const pagesWithLocalSchema = htmlPages.filter(p => p.schema.localTypes.length).length;
  // The proper parse decides whether the site has business schema at all; the homepage
  // regex above is only the demo pipeline's shortcut.
  const siteHasLocalSchema = !!(lb && lb.type !== "Organization");
  const homeHasLocalSchema = homeSchema.localTypes.length > 0;
  hasLocalSchema = siteHasLocalSchema || hasLocalSchema;
  const schemaPageWithIt = htmlPages.find(p => p.schema.localTypes.length);

  // ---- content quality ----
  const asText = htmlPages.map(p => ({ path: p.path, text: p.text || "" }));
  const readingPages = htmlPages.filter(p => (p.wordCount || 0) >= 120).map(p => ({ p, r: readability(p.text || "") }));
  const hardToRead = readingPages.filter(x => x.r.gradeLevel > 12);
  const stuffTerms = [...new Set([townPhrase, ...keywords(site.title || "").slice(0, 3)].filter(t => t && t.length >= 4))];
  const stuffed = stuffTerms.length ? htmlPages.filter(p => keywordStuffing(p.text || "", stuffTerms).stuffed) : [];
  const dupPairs = nearDuplicates(asText, 0.6);
  const boilerplate = boilerplateRatio(asText);
  const placeholders = htmlPages.map(p => ({ path: p.path, found: placeholderText(p.text || "") })).filter(x => x.found.length);
  const homeCta = ctaAboveFold(home.text);
  const anchorQ = anchorQuality(htmlPages.flatMap(p => p.anchors || []));
  const outlines = htmlPages.map(p => ({ p, o: headingOutline(p.headings || []) }));
  const skips = outlines.filter(x => x.o.skips > 0);
  const dupH1 = outlines.filter(x => x.o.dupH1);
  const mismatches = htmlPages.map(p => ({ p, m: titleH1Match(p.title || "", (p.h1s || [])[0] || "", p.path) })).filter(x => x.m.mismatch);
  const formsWeak = htmlPages.filter(p => p.hasForm && p.formInputs > 0 && p.formLabels === 0);
  const formsLong = htmlPages.filter(p => p.hasForm && p.formInputs > 7);

  // ---- certificate and Lighthouse detail ----
  const tls = https ? await tlsInfo(new URL(base).hostname) : null;
  const detail = lighthouseDetail(join(outDir, "lighthouse.json"));
  const detailDesktop = lighthouseDetail(join(outDir, "lighthouse-desktop.json"));
  // Lighthouse 13 moved most savings into *-insight audits; the legacy opportunity list is
  // nearly always empty now, so the merged savings list is what the rules quote.
  const savingLines = detail.ok && detail.savings.length
    ? detail.savings.slice(0, 6).map(s => `${s.title} (saves about ${Math.round(s.ms)} ms${s.kb ? ", " + Math.round(s.kb) + " KB" : ""})`)
    : (lh.opportunities || []).map(o => `${o.title} (saves ${o.save})`);
  const imgWasteKb = detail.ok ? detail.images.reduce((a, i) => a + (i.wastedKb || 0), 0) : 0;
  const thirdPartyMs = detail.ok ? detail.thirdParties.reduce((a, t) => a + (t.mainThreadMs || 0), 0) : 0;

  // ---- the rules ----
  // Each finding gets a stable id derived from its category and cost sentence (constant
  // per rule, unlike titles, which carry counts), so runs can be diffed and fixes tracked.
  const ruleId = (cat, cost) => { let h = 5381; const s = cat + "|" + cost; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return "r-" + (h >>> 0).toString(36); };
  const F = [];
  const add = (cat, w, title, cost, fix, effort, evidence = []) =>
    F.push({ id: ruleId(cat, cost), cat, w, title, cost, fix, effort, evidence: evidence.slice(0, 8) });

  // speed
  if (lh.ok && lh.perf < 50) add("speed", 85, `Mobile speed scores ${lh.perf}/100`,
    "Slow pages bleed visitors before they see the work, and speed is a ranking input Google publishes.",
    "Compress and resize hero images, defer non-critical scripts, target first paint under 2.5 seconds.", "1-2 days",
    savingLines);
  else if (lh.ok && lh.perf < 80) add("speed", 55, `Mobile speed scores ${lh.perf}/100, with real headroom left`,
    "Between 50 and 80 the page works but feels sluggish on a phone connection; the drop-off is invisible in analytics.",
    "Work the Lighthouse opportunity list top-down; each one is a measured saving.", "half a day",
    savingLines);
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
      "Soft 404s let Google index junk URLs and hide real broken links from every tool, including this one: the link check in this report could not see dead pages on this site.",
      "Return a real 404 status on unknown URLs, with a helpful page on top of it, then re-run the audit to get a real link check.", "1 hour");
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
  // Only a complete crawl can prove a page is linked from nowhere; a capped one can only
  // say it was not linked from the pages that were read.
  if (orphans.length && crawlComplete) add("tech", 50, `${orphans.length} page${orphans.length > 1 ? "s have" : " has"} no internal links pointing at it`,
    "An orphan page can only be found by luck; it inherits no authority from the rest of the site.",
    "Link every page from a menu, a hub page, or related-content blocks.", "half a day",
    orphans.slice(0, 8));
  else if (orphans.length) add("tech", 30, `${orphans.length} sitemap page${orphans.length > 1 ? "s were" : " was"} not linked from any of the ${htmlPages.length} pages crawled`,
    "Pages the crawl could not reach by following links may still be linked from pages it did not get to, so this is a lead, not a verdict.",
    "Raise the page limit or check these by hand, then link any true orphans from a menu or hub page.", "2 hours",
    orphans.slice(0, 8));
  if (robots?.googlebotBlocked) add("tech", 100, "robots.txt blocks Googlebot specifically",
    "A Googlebot group with Disallow: / removes the site from Google while every other crawler still gets in, so nothing looks wrong from a browser.",
    "Delete the Googlebot-specific Disallow: / rule and request re-indexing in Search Console.", "15 minutes",
    ["robots.txt applies a separate group to googlebot"]);
  if (xRobotsNoindex.length) add("tech", 90, `${xRobotsNoindex.length} page${xRobotsNoindex.length > 1 ? "s are" : " is"} hidden from search by an HTTP header`,
    "X-Robots-Tag: noindex is set by the server, so nothing in the page source gives it away; the page simply never ranks.",
    "Remove the header for anything that should be found, usually in the hosting or CDN settings.", "30 minutes",
    xRobotsNoindex.slice(0, 6).map(p => p.path));
  if (canonOffHost.length) add("tech", 85, `${canonOffHost.length} page${canonOffHost.length > 1 ? "s hand" : " hands"} its ranking to another website`,
    "A canonical tag pointing at a different domain tells Google the real page lives elsewhere. This usually comes from a template copied from an old site or a staging domain.",
    "Point every canonical at the page's own URL on this domain.", "1 hour",
    canonOffHost.slice(0, 6).map(p => `${p.path} -> ${p.canonicalHref}`));
  if (canonElsewhere.length > 1) add("tech", 40, `${canonElsewhere.length} pages canonicalise to a different page`,
    "Each of these tells Google to index a different URL instead of itself. That is right for true duplicates and wrong for real pages.",
    "Confirm each one is a deliberate duplicate; give every unique page a self-referencing canonical.", "1 hour",
    canonElsewhere.slice(0, 6).map(p => `${p.path} -> ${p.canonicalHref}`));
  if (redirectingLinks.length >= 2) add("tech", 35, `${redirectingLinks.length} internal links point at URLs that redirect`,
    "Every redirect hop is a slower page and a little lost ranking signal, on every visit, forever.",
    "Update the links to point straight at the final URL.", "2 hours",
    redirectingLinks.slice(0, 6).map(p => `${p.url} -> ${p.redirectedTo}`));
  if (tech.httpVariant && tech.httpVariant.hops > 1) add("tech", 25, `The insecure address reaches the site in ${tech.httpVariant.hops} hops`,
    "Each redirect in the chain adds a round trip before the first byte of the page.",
    "Redirect http and the non-canonical host straight to the final https URL in one hop.", "30 minutes",
    (tech.httpVariant.chain || []).map(c => `${c.status} ${c.from}`));
  if (sitemapDead.length) add("tech", 45, `${sitemapDead.length} sitemap URL${sitemapDead.length > 1 ? "s return" : " returns"} an error`,
    "A sitemap that lists dead pages wastes Google's crawl on this site and erodes its trust in the rest of the file.",
    "Regenerate the sitemap from live pages only.", "1 hour",
    sitemapDead.slice(0, 6).map(p => `${p.status} ${p.url}`));
  if (sitemapNoindex.length) add("tech", 40, `${sitemapNoindex.length} sitemap URL${sitemapNoindex.length > 1 ? "s are" : " is"} not indexable`,
    "The sitemap says 'index this' while the page itself says 'do not'. Google follows the page and stops trusting the sitemap.",
    "Remove noindexed and canonicalised URLs from the sitemap.", "1 hour",
    sitemapNoindex.slice(0, 6).map(p => `${p.path}: ${p.indexReason}`));
  if (sitemap.found && sitemap.offHost.length) add("tech", 35, `${sitemap.offHost.length} sitemap URL${sitemap.offHost.length > 1 ? "s point" : " points"} at another host`,
    "Sitemap entries must belong to the site that publishes them; the rest are ignored and count against the file.",
    "List only this domain's URLs.", "30 minutes", sitemap.offHost.slice(0, 5));
  if (sitemap.found && sitemap.sources.some(s => s.lastmodInvalid)) add("tech", 10, "The sitemap has dates Google cannot read",
    "An unreadable lastmod makes Google ignore every date in the file, so it stops knowing which pages changed.",
    "Use ISO dates in lastmod (2026-09-01) or leave the field out.", "15 minutes",
    sitemap.sources.filter(s => s.lastmodInvalid).map(s => `${s.url}: ${s.lastmodInvalid} invalid`));
  if (sitemap.found && robotsOk && !sitemap.declaredInRobots) add("tech", 15, "robots.txt does not name the sitemap",
    "A Sitemap: line is how crawlers other than Google find the file without being told.",
    "Add one line to robots.txt: Sitemap: " + origin + "/sitemap.xml", "15 minutes");
  if (brokenImages.length) add("content", 50, `${brokenImages.length} image${brokenImages.length > 1 ? "s are" : " is"} broken`,
    "A missing photo on a service page reads as a business that has stopped paying attention, and Google sees the same broken request.",
    "Re-upload or remove each one.", "1 hour",
    brokenImages.slice(0, 6).map(l => `${l.status || "no answer"} · ${l.url} (on ${l.from})`));
  if (brokenOg.length) add("trust", 30, "The social preview image does not load",
    "Shared links show a blank card on Facebook, iMessage and WhatsApp even though the tag is there.",
    "Point og:image at an image that exists, 1200 by 630, absolute URL.", "15 minutes", brokenOg.map(l => `${l.status || "no answer"} · ${l.url}`));
  if (noLang.length === htmlPages.length && htmlPages.length) add("content", 15, "Pages do not declare their language",
    "Without lang on the html tag, screen readers guess the pronunciation and search engines guess the market.",
    "Add lang=\"en\" (or the right code) to the html tag in the template.", "15 minutes");
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
  // Being behind a competitor is not a defect of the site, so this sits in its own unscored
  // category. The rule for each underlying gap still fires on its own.
  const cf = competitiveFinding(headToHead);
  if (cf) add("compete", cf.w, cf.title, cf.cost, cf.fix, cf.effort, cf.evidence);

  // local (skipped entirely for a site that is not a local business)
  if (siteType === "local") {
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
  if (!hasLocalSchema) add("local", 72, "No business schema, so Google cannot read the business details",
    "Structured data feeds the Google panel, maps, and rich results. Without it the listing runs on luck.",
    "Add LocalBusiness structured data: name, address, phone, hours, service area, map coordinates, and links to the profiles.", "2 hours",
    schemaTypes.length ? ["found instead: " + schemaTypes.join(", ")] : []);
  else if (siteHasLocalSchema && !homeHasLocalSchema) add("local", 45, "The business schema is missing from the homepage",
    "The homepage is the page Google reads first for who and where the business is; the schema lives on an inner page instead.",
    "Emit the same LocalBusiness block on the homepage (ideally from the site template).", "30 minutes",
    schemaPageWithIt ? [`found on ${schemaPageWithIt.path} (${lb.type})`] : []);
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
  // Google's review-snippet policy bars a business from marking up its own reviews with
  // AggregateRating, so the honest fix is to show real third-party reviews, not to add markup.
  if (selfServing || (schemaTypes.some(t => /AggregateRating|^Review$/i.test(t)) && hasLocalSchema))
    add("local", 40, "The site marks up its own reviews with star ratings",
      "Google treats self-serving review markup on a business's own pages as a policy violation and can drop rich results for the whole site.",
      "Remove AggregateRating and Review from the LocalBusiness schema; show reviews through an embedded Google or Yelp widget instead.", "30 minutes",
      [lb ? `aggregateRating inside the ${lb.type} block` : "found: " + schemaTypes.filter(t => /AggregateRating|Review/i.test(t)).join(", ")]);
  if (rating && !reviewPlatforms.length && !hasGoogleProfile)
    add("local", 30, `The ${rating}-star reputation is invisible on the site`,
      "The reviews exist on Google, but a visitor who arrives from anywhere else never sees them.",
      "Embed the Google reviews widget or link to the Google and Yelp profiles from every page footer.", "1 hour");
  if (!hasGoogleProfile) add("local", 35, "No link to the Google Business Profile or map listing",
    "The profile is where the calls come from on mobile; a site that never links to it leaves the two disconnected in Google's eyes and in the customer's.",
    "Link the address in the footer to the Google Maps listing and add the profile to sameAs in the schema.", "30 minutes");
  if (!reviewPlatforms.length && !(profilesFound.facebook || []).length) add("local", 20, "No links to any review or social profile",
    "Profiles on Yelp, Facebook or Houzz are where a cautious customer checks the story before calling.",
    "Add the profile links to the footer.", "15 minutes");
  if (!htmlPages.some(p => p.licenseMention)) add("local", 35, "No mention of a license, insurance or bonding",
    "For a contractor in New York it is a legal requirement to show the license number, and for any trade it is the first thing a homeowner looks for before letting a stranger in.",
    "Put the license number and 'licensed and insured' in the footer of every page and on the About page.", "15 minutes");
  if (!htmlPages.some(p => (p.bookingSignals || []).length) && !htmlPages.some(p => p.hasForm))
    add("local", 30, "No way to book, request a quote or ask for an estimate online",
      "Half of the people who want the work will not phone; they want to send the request and get on with their day.",
      "Add a short quote or booking form, or a 'request an estimate' button that opens one.", "2 hours");
  if (htmlPages.some(p => p.pdfMenu)) add("local", 25, "The menu is only available as a PDF",
    "A PDF does not resize on a phone, is slow to open on a data plan, and its dishes do not rank in search.",
    "Publish the menu as a normal page and keep the PDF as a download.", "2 hours");
  if (townWords.length && !homeNamesTownUpFront) add("local", 50, `The homepage title and headline do not say "${town.split(",")[0].trim()}"`,
    "Local searches are 'roofer near me' and 'roofer in <town>'. The title is what Google matches first, and the town is not in it.",
    "Put the service and the town in the homepage title and H1: '<Service> in <Town> · <Business>'.", "30 minutes",
    [`title: ${site.title || "(none)"}`, `h1: ${(site.h1s || [])[0] || "(none)"}`]);
  if (lb && lb.type !== "Organization" && lb.completeness < 70) add("local", 50, `The business schema is only ${lb.completeness}% complete`,
    "Google reads the schema for the panel and the map pin; half-filled schema is half a listing.",
    "Fill in the missing fields: " + lb.missing.join(", ") + ".", "1 hour", [`type: ${lb.type}`]);
  if (schemaPhoneMismatch) add("local", 60, "The phone number in the schema is not the one on the page",
    "Google sees two numbers for one business and trusts neither.",
    "Make the schema telephone match the number customers see.", "30 minutes",
    [`schema: ${pretty(lb.telephoneDigits)}`, `page: ${[...allPhones].map(pretty).join(", ")}`]);
  if (schemaGoogleMismatch && !napMismatch) add("local", 55, "The phone number in the schema is not the one Google shows",
    "The structured data is telling Google a different number than its own listing has.",
    "Align the schema telephone with the Google Business Profile.", "30 minutes", [`schema: ${pretty(lb.telephoneDigits)}`, `Google: ${gphone}`]);
  if (homeHasLocalSchema && pagesWithLocalSchema <= 1 && htmlPages.length >= 4) add("local", 25, "Business schema appears on the homepage only",
    "Service pages land visitors from search too; without the schema they carry no business identity.",
    "Emit the LocalBusiness block from the site template so every page has it.", "1 hour");
  if (formsWeak.length) add("local", 30, `${formsWeak.length} form${formsWeak.length === 1 ? " has" : "s have"} fields with no labels`,
    "Unlabelled fields defeat autofill and screen readers, and are the usual reason a phone form gets abandoned halfway.",
    "Give every field a visible label.", "1 hour", formsWeak.slice(0, 4).map(p => p.path));
  if (formsLong.length) add("local", 25, `${formsLong.length} form${formsLong.length === 1 ? " asks" : "s ask"} for more than seven fields`,
    "Every extra field costs completions; a quote request needs a name, a phone and what they need.",
    "Cut the form to three or four fields.", "1 hour", formsLong.slice(0, 4).map(p => `${p.path} (${p.formInputs} fields)`));
  }

  // content quality
  if (dupPairs.length) add("content", 55, `${dupPairs.length} pair${dupPairs.length === 1 ? "" : "s"} of pages say nearly the same thing`,
    "Two pages with the same copy split the ranking between them, and to a visitor the second one reads as filler.",
    "Merge each pair into one stronger page and redirect the other, or rewrite one for a genuinely different service or town.", "half a day",
    dupPairs.slice(0, 6).map(d => `${d.a} and ${d.b} share ${Math.round(d.similarity * 100)}% of their text`));
  if (placeholders.length) add("content", 60, `${placeholders.length} page${placeholders.length === 1 ? " still carries" : "s still carry"} template placeholder text`,
    "Lorem ipsum, a sample phone number or 'coming soon' tells a visitor the site was never finished.",
    "Replace or remove every placeholder.", "1 hour", placeholders.slice(0, 6).map(x => `${x.path}: ${x.found.join(", ")}`));
  if (!homeCta.found) add("content", 45, "Nothing to tap in the first screen of the homepage",
    "On a phone the first screen is the whole first impression; if there is no button to call or ask for a quote, most people scroll once and leave.",
    "Put a call button and a quote button above the fold on mobile.", "1 hour");
  if (anchorQ.generic + anchorQ.empty >= 5) add("content", 25, `${anchorQ.generic} generic and ${anchorQ.empty} empty links`,
    "'Click here' tells neither the visitor nor Google where the link goes, and an empty link is invisible to both.",
    "Write link text that names the destination.", "2 hours", anchorQ.examples.map(e => `"${e.text || "(empty)"}" -> ${e.href}`));
  if (mismatches.length >= 2) add("content", 35, `${mismatches.length} pages have a headline that does not match their title`,
    "Google shows the title; the visitor reads the headline. When they disagree, the click feels like a wrong turn.",
    "Make the H1 and the title say the same thing in different words.", "2 hours",
    mismatches.slice(0, 6).map(x => `${x.p.path}: "${x.p.title}" vs "${(x.p.h1s || [])[0]}"`));
  if (skips.length > 1) add("content", 20, `${skips.length} pages skip heading levels`,
    "Jumping from a main heading to a sub-sub-heading confuses screen readers and the outline Google builds of the page.",
    "Use H2 for sections and H3 inside them, in order.", "1 hour", skips.slice(0, 5).map(x => x.p.path));
  if (dupH1.length) add("content", 25, `${dupH1.length} page${dupH1.length === 1 ? " repeats" : "s repeat"} the same headline twice`,
    "The same H1 twice usually means a template printed it in two places; it dilutes the one headline that matters.",
    "Keep one H1 per page.", "1 hour", dupH1.slice(0, 5).map(x => x.p.path));
  if (readingPages.length >= 2 && hardToRead.length > readingPages.length / 2) add("content", 25, "Most pages read at college level",
    "Homeowners skim on a phone; copy that needs a degree loses them by the second paragraph.",
    "Shorter sentences, everyday words, one idea per paragraph. Aim for grade 8.", "half a day",
    hardToRead.slice(0, 5).map(x => `${x.p.path}: grade ${x.r.gradeLevel}`));
  if (stuffed.length) add("content", 40, `${stuffed.length} page${stuffed.length === 1 ? " repeats" : "s repeat"} the same keyword to the point of stuffing`,
    "Google discounts pages that say the town or the service every other sentence, and people notice too.",
    "Say it once in the title, once in the headline, and write the rest for a person.", "2 hours", stuffed.slice(0, 5).map(p => p.path));
  if (htmlPages.length >= 5 && boilerplate > 0.6) add("content", 30, `${Math.round(boilerplate * 100)}% of the words on a typical page are repeated site furniture`,
    "When most of a page is the same menu, footer and sidebar as every other page, there is little left for Google to rank it on.",
    "Cut repeated blocks and give each page more of its own copy.", "half a day");

  // certificate
  if (tls && tls.ok && tls.authorized === false) add("tech", 90, "The security certificate is not trusted",
    `Browsers show "Your connection is not private" before the page (${tls.authorizationError || "certificate error"}).`,
    "Install a certificate from a trusted authority for this exact hostname; Let's Encrypt is free.", "1 hour", [tls.authorizationError || ""]);
  if (tls && tls.ok && typeof tls.daysLeft === "number" && tls.daysLeft < 30) add("tech", 80, `The security certificate expires in ${tls.daysLeft} day${tls.daysLeft === 1 ? "" : "s"}`,
    "When it lapses every browser shows a full-page warning and the site is effectively down.",
    "Renew it now and turn on automatic renewal.", "30 minutes", [`valid to ${tls.validTo}`, `issuer: ${tls.issuer}`]);
  if (tls && tls.ok && tech.wwwVariant?.ok && tech.apexVariant?.ok && (!tls.coversWww || !tls.coversApex))
    add("tech", 45, "The certificate does not cover both www and non-www",
      "Whichever hostname is not covered shows a security warning to anyone who types it.",
      "Reissue the certificate with both names, or a wildcard.", "30 minutes", [`covers: ${(tls.altNames || []).slice(0, 4).join(", ")}`]);

  // speed detail
  if (imgWasteKb > 300) add("speed", 55, `${Math.round(imgWasteKb)} KB of images are bigger than they need to be`,
    "Oversized photos are the single most common reason a small-business site is slow on a phone.",
    "Resize to the displayed size, serve WebP or AVIF, and lazy-load anything below the fold.", "2 hours",
    detail.images.slice(0, 6).map(i => `${Math.round(i.wastedKb)} KB wasted: ${i.url}${i.reason ? " (" + i.reason + ")" : ""}`));
  if (thirdPartyMs > 1000) add("speed", 40, `Third-party scripts block the page for ${Math.round(thirdPartyMs)} ms`,
    "Chat widgets, trackers and embeds run before the visitor can tap anything.",
    "Load them after the page is interactive, or remove the ones nobody uses.", "2 hours",
    detail.thirdParties.slice(0, 6).map(t => `${t.entity}: ${Math.round(t.mainThreadMs)} ms, ${Math.round(t.kb)} KB`));
  if (detail.ok && detail.renderBlocking.length > 2) add("speed", 35, `${detail.renderBlocking.length} files block the first paint`,
    "Nothing shows until these stylesheets and scripts have downloaded, on every visit.",
    "Inline the critical CSS and defer the rest.", "2 hours", detail.renderBlocking.slice(0, 6).map(r => `${r.url} (${Math.round(r.kb)} KB)`));
  if (detail.ok && detail.weight.totalKb > 3000) add("speed", 45, `The homepage weighs ${(detail.weight.totalKb / 1024).toFixed(1)} MB`,
    "Three megabytes on a phone connection is several seconds of waiting before anything is usable.",
    "Compress images, drop unused scripts, and self-host only the fonts actually in use.", "half a day",
    Object.entries(detail.weight.byType || {}).filter(([, kb]) => kb > 50).map(([k, kb]) => `${k}: ${Math.round(kb)} KB`));
  if (detail.ok && detail.fonts.count > 4) add("speed", 20, `${detail.fonts.count} font files load on the homepage`,
    "Each weight and style is another download before the text settles.",
    "Keep two weights of one family and self-host them.", "1 hour");

  // structure and measurement
  const deepPages = htmlPages.filter(p => p.depth !== null && p.depth >= 4);
  if (deepPages.length) add("tech", 42, `${deepPages.length} page${deepPages.length === 1 ? " is" : "s are"} four or more clicks from the homepage`,
    "Pages buried that deep are crawled less often and inherit almost no authority; they rarely rank for anything.",
    "Link them from a service hub or the main menu so every page is reachable in three clicks.", "half a day",
    deepPages.slice(0, 8).map(p => `${p.path} (${p.depth} clicks)`));
  const slowInner = lighthousePages.filter(x => x.ok && x.perf !== null && (x.perf < 50 || (lh.ok && x.perf < lh.perf - 20)));
  if (slowInner.length) add("speed", 60, `${slowInner.length} inner page${slowInner.length === 1 ? " is" : "s are"} much slower than the homepage`,
    "Search sends people to service pages, not the homepage. A fast front door with slow rooms behind it still loses the visitor.",
    "Apply the homepage's image and script optimisations to every template, not just the front page.", "half a day",
    slowInner.map(x => `${x.path}: ${x.perf}/100 mobile${x.lcp ? `, main content at ${x.lcp}` : ""}`));
  if (crawl.rendered) add("tech", 30, `${crawl.rendered} page${crawl.rendered === 1 ? " only works" : "s only work"} with JavaScript switched on`,
    "The content is not in the HTML at all; it is assembled in the browser. Google can render it, but later and less reliably, and any other crawler sees a blank page.",
    "Render the pages on the server or pre-build them to static HTML so the words are in the page when it arrives.", "1-2 days",
    htmlPages.filter(p => p.rendered).slice(0, 6).map(p => p.path));

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
  else if (!site.ogImage) add("trust", 22, "The social preview has no image",
    "A shared link with a title but no picture is the card people scroll past.",
    "Add og:image pointing at a real photo, 1200 by 630 pixels.", "15 minutes");
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
  const scores = scoreOf(findings, lh, { siteType });
  // Things the reader must know about how this run went, separate from findings about the site.
  const runNotes = [...scores.notes];
  if (linksReliable === false) runNotes.push(`This site answers HTTP ${tech.notFoundStatus} for pages that do not exist, so dead links could not be detected. The link counts below are not reliable.`);
  if (crawl.truncatedByTime) runNotes.push(`The crawl stopped at its ${Math.round(budgetMs / 60000)}-minute budget after ${htmlPages.length} pages; the site has more.`);
  if (crawl.rendered) runNotes.push(`${crawl.rendered} page${crawl.rendered === 1 ? "" : "s"} had to be rendered in a browser before there was anything to read.`);

  const data = {
    pro: true, name, url: base, town, date: new Date().toISOString().slice(0, 10),
    rating, reviews, gphone, slug, outDir, maxPages, siteType, runNotes,
    lighthouse: lh, lighthouseDesktop: lhDesktop, lighthousePages, tech, scores,
    site: { ...site, https, hasLocalSchema, altPct, schemaTypes, text: undefined, html: undefined },
    robots: robotsOk ? { ...robots, raw: robotsRes.text.slice(0, 2000) } : null,
    sitemap: { found: sitemap.found, count: sitemap.urls.length, sources: sitemap.sources, indexed: sitemap.indexed },
    crawl: {
      pages: htmlPages.map(({ text, headings, html, links, anchors, imgSrcs, schema, ...p }) =>
        ({ ...p, schema: schema ? { types: schema.types, localTypes: schema.localTypes, completeness: schema.localBusiness ? schema.localBusiness.completeness : null } : undefined })),
      pagesCrawled: crawl.pages.length, discovered: crawl.queuedTotal,
      skippedByRobots: crawl.skippedByRobots,
      internalLinksFound: crawl.internalLinks.size, externalLinksFound: crawl.externalLinks.size,
      linksChecked: checkedCount, rendered: crawl.rendered, truncatedByTime: crawl.truncatedByTime, elapsedMs: crawl.elapsedMs,
      maxDepth: Math.max(0, ...htmlPages.map(p => p.depth ?? 0)),
    },
    links: { broken: [...brokenInternal, ...brokenExternal], blocked: blockedLinks,
             brokenInternal: brokenInternal.length, brokenExternal: brokenExternal.length,
             brokenImages, brokenOg, imagesChecked: imageEntries.length,
             redirecting: redirectingLinks.map(p => ({ from: p.url, to: p.redirectedTo })),
             reliable: linksReliable },
    indexability: {
      indexable: htmlPages.filter(p => p.indexable).length, notIndexable: htmlPages.filter(p => !p.indexable).map(p => ({ path: p.path, reason: p.indexReason })),
      xRobotsNoindex: xRobotsNoindex.map(p => p.path), canonicalOffHost: canonOffHost.map(p => p.path), canonicalElsewhere: canonElsewhere.map(p => p.path),
      sitemapDead: sitemapDead.map(p => p.url), sitemapNotIndexable: sitemapNoindex.map(p => p.path), sitemapOffHost: sitemap.offHost.slice(0, 20),
      robotsAppliedTo: robots?.appliedTo || null, googlebotBlocked: !!robots?.googlebotBlocked, crawlComplete,
    },
    profiles: profilesFound,
    schema: { home: { ...homeSchema, blocks: undefined }, localBusiness: lb, pagesWithLocalSchema, selfServing,
              phoneMismatch: schemaPhoneMismatch, googleMismatch: schemaGoogleMismatch },
    quality: {
      readability: readingPages.map(x => ({ path: x.p.path, grade: x.r.gradeLevel, ease: x.r.readingEase })),
      hardToRead: hardToRead.length, nearDuplicates: dupPairs.slice(0, 20), boilerplate: Math.round(boilerplate * 100) / 100,
      placeholders, homeCta, anchors: { total: anchorQ.total, empty: anchorQ.empty, generic: anchorQ.generic, examples: anchorQ.examples },
      headingSkips: skips.map(x => x.p.path), dupH1: dupH1.map(x => x.p.path), titleMismatch: mismatches.map(x => x.p.path),
      stuffed: stuffed.map(p => p.path), formsWeak: formsWeak.map(p => p.path), formsLong: formsLong.map(p => p.path),
    },
    tls,
    detail: detail.ok ? { ...detail, screenshots: { final: detail.screenshots.final, fullPage: detail.screenshots.fullPage,
      frames: detail.screenshots.frames.filter((_, i, a) => i === 0 || i === Math.floor(a.length / 2) || i === a.length - 1) } } : null,
    detailDesktop: detailDesktop.ok ? { screenshots: { final: detailDesktop.screenshots.final }, weight: detailDesktop.weight,
      savings: detailDesktop.savings.slice(0, 8), lcp: detailDesktop.lcp } : null,
    stamp,
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
    discovery,
    headToHead,
    findings,
    fixes: findings.slice(0, 5),
  };
  // What changed since the last run of this same site, if there was one.
  const prev = previousRun(outDir, stamp);
  data.history = prev && prev.data ? {
    previous: { stamp: prev.stamp, date: prev.data.date, scores: prev.data.scores, findings: (prev.data.findings || []).length },
    diff: diffRuns(prev.data, data),
  } : null;
  writeFileSync(join(outDir, "audit-pro.json"), JSON.stringify(data, null, 2));
  return data;
}
