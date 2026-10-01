// Finds a site's competitors the way a customer would: a search for what the business does
// plus where it is, minus the directories, the social networks, the platforms and the site
// itself. Keyless, like the rest of the tool: the HTML endpoints of DuckDuckGo and Bing, read
// with a browser user agent, top three distinct business domains, homepage only. Both
// pipelines call discoverCompetitors() when a run asks for it and fewer than three
// competitors were pasted.
//   node discover.mjs --selftest
//   node discover.mjs --live https://example.com "Business Name" "Town, ST"
import { execFileSync } from "node:child_process";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// Directories, marketplaces, social networks, site builders and publishers: they rank for
// every local query and none of them is the business down the road.
const SKIP_HOSTS = /(^|\.)(yelp|angi|angieslist|homeadvisor|thumbtack|houzz|porch|bark|nextdoor|networx|fixr|homeguide|homestars|buildzoom|expertise|threebestrated|facebook|instagram|linkedin|twitter|x|youtube|tiktok|pinterest|reddit|quora|medium|substack|yellowpages|yellowbook|superpages|dexknows|citysearch|foursquare|merchantcircle|manta|hotfrog|cylex|brownbook|nicelocal|birdeye|judysbook|insiderpages|kudzu|local|chamberofcommerce|bbb|mapquest|waze|google|bing|duckduckgo|yahoo|aol|msn|apple|microsoft|wikipedia|wiktionary|wikihow|britannica|dictionary|merriam-webster|cambridge|vocabulary|thefreedictionary|collinsdictionary|investopedia|indeed|glassdoor|ziprecruiter|monster|careerbuilder|zoominfo|crunchbase|dnb|opencorporates|bizapedia|buzzfile|bizbuysell|loopnet|tripadvisor|zillow|realtor|redfin|apartments|craigslist|amazon|ebay|etsy|walmart|homedepot|lowes|thespruce|bobvila|hgtv|thisoldhouse|familyhandyman|consumeraffairs|nerdwallet|thegeneral|findlaw|avvo|justia|healthgrades|zocdoc|webmd|vitals|opentable|doordash|grubhub|ubereats|seamless|trustpilot|sitejabber|clutch|upwork|fiverr|alignable|patch|nytimes|nypost|forbes|bloomberg|yimby|newyorkyimby|curbed|blogspot|wordpress|wix|wixsite|squarespace|godaddy|weebly|site123|webflow|shopify|tumblr)\.(com|org|net|co|io|us|ca|uk|me)$/i;
const SKIP_TLD = /\.(gov|edu|mil)$/i;
// Nothing a search engine returns should point back into this machine or a private network.
const PRIVATE = /^(localhost|0\.0\.0\.0|::1|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)|\.(local|internal|localhost)$/i;

export const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const strip = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

// ---------- what the business does ----------
const STOP = new Set(("the a an and or of in on for with to your our we you at from by is are home page welcome llc inc co this that all more " +
  "services service company companies best top near area free estimate estimates call today official site website quality professional " +
  "professionals local affordable trusted reliable experienced expert experts serving since years family owned operated licensed insured " +
  "get quote contact about new york city nyc usa online").split(" "));
const words = s => (String(s || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).map(w => w.replace(/'s$/, ""));
// Filler on its own, but the second half of a phrase worth searching for ("construction company").
const TRADE_TAIL = new Set("company companies contractor contractors services service repair repairs shop store studio clinic agency firm group center salon spa cleaning".split(" "));

// The phrase that says what the business does, read from the title, the headline and the
// description with the brand, the town and the filler taken out: the strongest two-word
// phrase the page itself uses, or the two strongest words in page order.
export function serviceTerms({ title, h1s = [], metaDesc, name, town }) {
  const fields = [[title, 2], ...h1s.map(h => [h, 2]), [metaDesc, 1]].filter(([s]) => s);
  const all = words(fields.map(([s]) => s).join(" . "));
  const place = new Set(words(town));
  // A brand word is dropped only where it never appears outside the name: "Astoria Roofing"
  // gives up "roofing", but "Koerner Construction" keeps "construction" when the page says
  // "construction company" three more times.
  const nameWords = words(name);
  const nameHits = nameWords.length ? all.join(" ").split(nameWords.join(" ")).length - 1 : 0;
  const count = t => all.filter(w => w === t).length;
  const brandOnly = new Set(nameWords.filter(t => count(t) <= nameHits));
  const usable = t => !STOP.has(t) && !place.has(t) && !brandOnly.has(t);
  const weight = new Map(), pairs = new Map();
  for (const [s, w] of fields) {
    const ws = words(s);
    ws.forEach((t, i) => {
      if (usable(t)) weight.set(t, (weight.get(t) || 0) + w);
      const n = ws[i + 1];
      if (n && usable(t) && (usable(n) || TRADE_TAIL.has(n))) pairs.set(t + " " + n, (pairs.get(t + " " + n) || 0) + w);
    });
  }
  const single = [...weight].sort((a, b) => b[1] - a[1]);
  const pair = [...pairs].sort((a, b) => b[1] - a[1])[0];
  let terms = pair ? pair[0] : "";
  if (!terms) {
    const top = single.slice(0, 2).map(([t]) => t);
    top.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    terms = top.join(" ");
  }
  // A site whose every word is its own name ("Astoria Roofing", and nothing else) still gets
  // searched for the part of the name that is a trade.
  if (!terms) { const rest = nameWords.filter(t => !STOP.has(t) && !place.has(t)); terms = rest[rest.length - 1] || ""; }
  const alt = single.length && single[0][0] !== terms ? single[0][0] : "";
  return { terms, alt };
}

// ---------- where the business is ----------
const STATES = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ");
const LEAD_IN = /^(Serving|Call|Contact|Visit|Located|In|Near|Around|Throughout|Across|Welcome|The|Our|Your|All|Of|To|And|At|From|For) /;
// "City, ST" from the page: the structured address first, then the most repeated match in
// the copy, with a ZIP code after it counting for more.
export function guessTown(html) {
  const s = String(html || "");
  const loc = s.match(/"addressLocality"\s*:\s*"([^"]{2,40})"/), reg = s.match(/"addressRegion"\s*:\s*"([^"]{2,20})"/);
  if (loc) return reg ? `${loc[1].trim()}, ${reg[1].trim()}` : loc[1].trim();
  const text = strip(s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "));
  const re = new RegExp(`\\b([A-Z][a-z]+(?: [A-Z][a-z]+){0,2}),? (${STATES.join("|")})\\b( \\d{5})?`, "g");
  const counts = new Map();
  for (const m of text.matchAll(re)) {
    const city = m[1].replace(LEAD_IN, "").replace(LEAD_IN, "");
    if (!city) continue;
    const k = `${city}, ${m[2]}`;
    counts.set(k, (counts.get(k) || 0) + (m[3] ? 3 : 1));
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// ---------- reading the result pages ----------
export function parseDuckDuckGo(html) {
  const out = [];
  for (const b of String(html).split(/<div[^>]+class="result\b/i).slice(1)) {
    if (/result--ad|badge--ad/i.test(b.slice(0, 300))) continue;
    const a = b.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let href = a[1].replace(/&amp;/g, "&");
    if (href.startsWith("//")) href = "https:" + href;
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) { try { href = decodeURIComponent(m[1]); } catch {} }
    if (!/^https?:\/\//i.test(href)) continue;
    const sn = b.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    out.push({ url: href, title: strip(a[2]), snippet: sn ? strip(sn[1]) : "" });
  }
  return out;
}
// The lite page: one anchor per result (class in single quotes), ads routed through
// duckduckgo.com itself, the snippet in the next table cell.
export function parseDuckDuckGoLite(html) {
  const out = [];
  const re = /<a\b([^>]*class=['"]result-link['"][^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*class=['"]result-link['"]|$)/gi;
  for (const m of String(html).matchAll(re)) {
    let href = (m[1].match(/href=["']([^"']+)["']/) || [])[1] || "";
    href = href.replace(/&amp;/g, "&");
    if (href.startsWith("//")) href = "https:" + href;
    const u = href.match(/[?&]uddg=([^&]+)/);
    if (u) { try { href = decodeURIComponent(u[1]); } catch {} }
    if (!/^https?:\/\//i.test(href) || /^https?:\/\/(www\.)?duckduckgo\.com\//i.test(href)) continue;
    const sn = m[3].match(/<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
    out.push({ url: href, title: strip(m[2]), snippet: sn ? strip(sn[1]) : "" });
  }
  return out;
}
export function parseBing(html) {
  const out = [];
  for (const block of String(html).split(/<li class="b_algo"/i).slice(1)) {
    const m = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    let href = m[1].replace(/&amp;/g, "&");
    const ck = href.match(/^https?:\/\/www\.bing\.com\/ck\/a\?.*[?&]u=a1([^&]+)/i);
    if (ck) { try { href = Buffer.from(ck[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch {} }
    if (!/^https?:\/\//i.test(href)) continue;
    const sn = block.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ url: href, title: strip(m[2]), snippet: sn ? strip(sn[1]) : "" });
  }
  return out;
}

// ---------- is it actually there? ----------
const STATE_NAMES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska",
  NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia" };
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A search engine pads a small town's results with pages from anywhere. A candidate counts
// as local when its title, snippet or address names the town, or the state (the two-letter
// code only in capitals, so "in" and "or" never pass for Indiana and Oregon).
export function isLocal(c, town) {
  if (!town) return true;
  const [cityPart, statePart = ""] = String(town).split(",").map(s => s.trim());
  const st = statePart.length === 2 ? statePart.toUpperCase() : (Object.entries(STATE_NAMES).find(([, n]) => n.toLowerCase() === statePart.toLowerCase()) || [""])[0];
  const text = `${c.title || ""} ${c.snippet || ""}`;
  const address = String(c.host || "").replace(/[-._]/g, " ");
  if (cityPart && new RegExp(`\\b${escapeRe(cityPart)}\\b`, "i").test(`${text} ${address}`)) return true;
  if (st && new RegExp(`(^|[\\s,(])${st}\\b`).test(text)) return true;
  if (st && STATE_NAMES[st] && new RegExp(`\\b${escapeRe(STATE_NAMES[st])}\\b`, "i").test(text)) return true;
  return false;
}

// One candidate per domain, homepage only, scored by where each engine ranked it, with a
// bonus when both engines return it: agreement beats one engine's top slot.
export function rankCandidates(lists, { own, exclude = [], want = 3 } = {}) {
  const ownHost = hostOf(own);
  const listed = new Set(exclude.map(hostOf).filter(Boolean));
  const seen = new Map();
  const skipped = { own: 0, listed: 0, directories: 0 };
  for (const { source, results } of lists) {
    results.forEach((r, i) => {
      const host = hostOf(r.url);
      if (!host) return;
      if (host === ownHost || host.endsWith("." + ownHost)) { skipped.own++; return; }
      if (listed.has(host)) { skipped.listed++; return; }
      if (SKIP_HOSTS.test(host) || SKIP_TLD.test(host) || PRIVATE.test(host)) { skipped.directories++; return; }
      const c = seen.get(host) || { host, url: new URL(r.url).origin + "/", title: r.title, snippet: r.snippet || "", score: 0, sources: [] };
      if (!c.snippet && r.snippet) c.snippet = r.snippet;
      c.score += 1 / (i + 1);
      if (!c.sources.includes(source)) { if (c.sources.length) c.score += 0.5; c.sources.push(source); }
      seen.set(host, c);
    });
  }
  const candidates = [...seen.values()].sort((a, b) => b.score - a.score);
  return { candidates, picked: candidates.slice(0, want).map(c => c.url), skipped };
}

async function searchFetch(url) {
  const headers = { "user-agent": UA, "accept-language": "en-US,en;q=0.9", accept: "text/html,application/xhtml+xml" };
  try {
    const r = await fetch(url, { redirect: "follow", headers, signal: AbortSignal.timeout(12000) });
    return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : "" };
  } catch {
    try {
      const text = execFileSync("curl", ["-sL", "--ssl-no-revoke", "--max-time", "12", "-A", UA, "-H", "Accept-Language: en-US,en;q=0.9", url], { encoding: "utf8", maxBuffer: 20e6 });
      return { ok: text.length > 0, status: text.length ? 200 : 0, text };
    } catch { return { ok: false, status: 0, text: "" }; }
  }
}
export const ENGINES = [
  { name: "duckduckgo", url: q => "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), parse: parseDuckDuckGo,
    blocked: (h, status) => status === 202 || /anomaly-modal|class="challenge|captcha/i.test(h),
    // The lite page is served separately and usually still answers when the html one challenges.
    fallback: { name: "duckduckgo-lite", url: q => "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q), parse: parseDuckDuckGoLite,
      blocked: (h, status) => status === 202 || /anomaly-modal|captcha/i.test(h) } },
  // Without the market pinned, Bing answers a bot with a page from wherever it guesses.
  { name: "bing", url: q => "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&setlang=en-US&mkt=en-US&cc=US&count=20", parse: parseBing,
    blocked: h => /b_captcha|captcha\.js/i.test(h) },
];
// DuckDuckGo answers a burst of requests with a challenge page (HTTP 202); a pause between
// calls keeps it talking.
const pause = ms => new Promise(r => setTimeout(r, ms));

// url, name, town and the homepage's title, h1s, metaDesc and html come from the pipeline.
// exclude: competitors already on the list. want: how many more to find (at most three).
export async function discoverCompetitors({ url, name, town, title, h1s = [], metaDesc, html, exclude = [], want = 3, fetcher = searchFetch, engines = ENGINES }) {
  const st = serviceTerms({ title, h1s, metaDesc, name, town, url });
  let where = town || null, townSource = town ? "given" : null;
  if (!where) { where = guessTown(html); townSource = where ? "page" : null; }
  const out = { terms: st.terms, town: where, townSource, queries: [], engines: [], candidates: [], picked: [], skipped: { own: 0, listed: 0, directories: 0, elsewhere: 0 }, note: null };
  if (!st.terms) { out.note = "Could not tell what the business does from its own pages, so there was nothing to search for."; return out; }
  const q = t => where ? `${t} ${where}` : t;
  const queries = [q(st.terms)];
  if (st.alt && st.alt !== st.terms) queries.push(q(st.alt));
  const lists = [];
  let calls = 0;
  for (const query of queries) {
    out.queries.push(query);
    for (const e of engines) {
      if (calls++ && fetcher === searchFetch) await pause(1500);
      let engine = e, r = await fetcher(engine.url(query));
      let blocked = r.ok && engine.blocked(r.text, r.status);
      if (blocked && e.fallback) {
        if (fetcher === searchFetch) await pause(1500);
        engine = e.fallback; r = await fetcher(engine.url(query));
        blocked = r.ok && engine.blocked(r.text, r.status);
      }
      const results = r.ok && !blocked ? engine.parse(r.text) : [];
      out.engines.push({ engine: engine.name, query, status: r.status, results: results.length, blocked });
      // The fallback counts as the same engine, so agreement between engines stays meaningful.
      lists.push({ source: e.name, results });
    }
    const ranked = rankCandidates(lists, { own: url, exclude, want });
    const local = ranked.candidates.filter(c => isLocal(c, where));
    // A pick has to be top on one engine or well placed on both (0.9: fifth on both). With
    // one engine answering there is no agreement to ask for, so its top four will do.
    const answered = new Set(out.engines.filter(e => e.results > 0).map(e => e.engine.replace(/-lite$/, ""))).size;
    const minScore = answered >= 2 ? 0.9 : 0.25;
    Object.assign(out, { candidates: local.slice(0, 10), minScore, picked: local.filter(c => c.score >= minScore).slice(0, want).map(c => c.url),
      skipped: { ...ranked.skipped, elsewhere: ranked.candidates.length - local.length } });
    if (out.picked.length >= want) break;
  }
  if (!where) out.note = "No town was given and none could be read from the page, so the search was not local.";
  if (!out.picked.length) {
    out.note = out.engines.every(e => e.results === 0)
      ? (out.engines.some(e => e.blocked) ? "The search engines refused the request (a bot check), so no competitors could be found."
        : "The search returned no usable results.")
      : out.skipped.elsewhere ? `The search found businesses, but none that say they are in ${where}.`
      : "Every result was a directory, a platform or the site itself.";
  }
  return out;
}

// ---------- self-test ----------
if (process.argv.includes("--selftest")) {
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}`); } };

  const fixture = { url: "http://astoria-roofing.example/", name: "Astoria Roofing", town: "Astoria, NY",
    title: "Astoria Roofing: Roof Repair in Astoria, Queens", h1s: ["Roof repair in Astoria"],
    metaDesc: "Roof repair, gutters and siding in Astoria, Queens. Call for a free estimate today from a licensed local crew." };
  const st = serviceTerms(fixture);
  check("service terms drop the brand, the town and the filler", st.terms === "roof repair");
  check("alt query is the single strongest word", st.alt === "roof");
  check("a name-only site still searches for its trade", serviceTerms({ ...fixture, title: "Astoria Roofing", h1s: [], metaDesc: "" }).terms === "roofing");
  check("nothing to go on gives empty terms", serviceTerms({ url: "http://x.example/", name: "", title: "", h1s: [], metaDesc: "" }).terms === "");
  check("word order follows the page when no phrase exists", serviceTerms({ ...fixture, title: "Repair your roof: Astoria Roofing", h1s: [], metaDesc: "" }).terms === "repair roof");
  const koerner = serviceTerms({ url: "https://koernerconstruction.com/", name: "Koerner Construction", town: "Red Hook, NY",
    title: "Construction Company Dutchess Ulster Columbia Greene", h1s: ["Construction Company | Dutchess"],
    metaDesc: "Koerner Construction LLC, is a full service construction company serving Dutchess, Ulster, Columbia" });
  check("a brand word the page uses as its trade is kept, and the phrase beats the county list", koerner.terms === "construction company" && koerner.alt === "construction");

  check("town from structured data", guessTown('<script type="application/ld+json">{"address":{"addressLocality":"Red Hook","addressRegion":"NY"}}</script>') === "Red Hook, NY");
  check("town from the copy, ZIP outranks a lone mention", guessTown("<p>Serving Queens, NY and Brooklyn, NY.</p><footer>12 Ditmars Blvd, Astoria, NY 11105</footer>") === "Astoria, NY");
  check("lead-in words are stripped", guessTown("<p>Serving Astoria, NY since 2009. Serving Astoria, NY.</p>") === "Astoria, NY");
  check("no town gives null", guessTown("<p>We fix roofs.</p>") === null);

  const ddg = `<div class="result results_links results_links_deep result--ad"><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></h2></div>
    <div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body"><h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rival.example%2Froof-repair&amp;rd=1">Rival <b>Roofing</b> Astoria</a></h2>
    <a class="result__snippet" href="https://www.rival.example/roof-repair">Roof repair and replacement in Astoria, Queens.</a></div></div>
    <div class="result results_links results_links_deep web-result "><h2 class="result__title"><a class="result__a" href="https://www.yelp.com/search?find_desc=roofers">Yelp</a></h2></div>
    <div class="result results_links results_links_deep web-result "><h2 class="result__title"><a class="result__a" href="https://other.example/">Other Roofing</a></h2>
    <a class="result__snippet" href="https://other.example/">Roofers at 40 Ditmars Blvd, Astoria, NY 11105.</a></div>`;
  const d = parseDuckDuckGo(ddg);
  check("duckduckgo: ad skipped, redirect decoded, three organic results", d.length === 3 && d[0].url === "https://www.rival.example/roof-repair" && d[0].title === "Rival Roofing Astoria");
  check("duckduckgo: snippet captured", d[0].snippet === "Roof repair and replacement in Astoria, Queens." && d[1].snippet === "");
  const u = Buffer.from("https://third.example/services").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const bing = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;p=abc&amp;u=a1${u}&amp;ntb=1" h="ID=1">Third Roofing</a></h2><div class="b_caption"><p class="b_lineclamp2" data-x="">Serving Astoria and all of Queens, NY since 1998.</p></div></li>
    <li class="b_algo"><div class="b_title"><h2><a href="https://other.example/about" h="ID=2">Other Roofing</a></h2></div><div class="b_caption"><p>Astoria roofing company.</p></div></li>
    <li class="b_algo"><h2><a href="http://astoria-roofing.example/contact">The site itself</a></h2></li>`;
  const b = parseBing(bing);
  check("bing: tracking link decoded, plain link kept", b.length === 3 && b[0].url === "https://third.example/services" && b[1].url === "https://other.example/about");
  check("bing: snippet captured from either caption shape", b[0].snippet.startsWith("Serving Astoria") && b[1].snippet === "Astoria roofing company." && b[2].snippet === "");

  const lite = `<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dangi.com&amp;rut=1" class='result-link'>Roofing Contractors Near You</a></td></tr>
    <tr><td class='result-snippet'>Enter your zip.</td></tr>
    <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flyndseyroofing.example%2Fredhook%2Dny%2F&amp;rut=2" class='result-link'>Trusted Roofers in Red Hook, NY | Lyndsey</a></td></tr>
    <tr><td class='result-snippet'>Red Hook, NY roofing company since 2004.</td></tr>
    <tr><td><a rel="nofollow" href="https://roofingpro.example/red-hook" class="result-link">Roofing Contractor Red Hook NY</a></td></tr>`;
  const l = parseDuckDuckGoLite(lite);
  check("duckduckgo lite: ad skipped, redirect decoded, snippet from the next cell, either quote style", l.length === 2
    && l[0].url === "https://lyndseyroofing.example/redhook-ny/" && l[0].snippet === "Red Hook, NY roofing company since 2004." && l[1].url === "https://roofingpro.example/red-hook" && l[1].snippet === "");

  const georgia = { host: "bowserconstructiongroup.com", title: "General Contractor In Sandy Springs , GA | BCG", snippet: "Licensed and insured." };
  check("isLocal: another state is not local", !isLocal(georgia, "Red Hook, NY"));
  check("isLocal: the town in the title counts", isLocal({ host: "x.example", title: "Roofers in Red Hook", snippet: "" }, "Red Hook, NY"));
  check("isLocal: the town in the address counts", isLocal({ host: "red-hook-ny.jahpro.example", title: "Roofing Contractors", snippet: "" }, "Red Hook, NY"));
  check("isLocal: the state name in the snippet counts", isLocal({ host: "x.example", title: "Roofers", snippet: "Serving all of New York state" }, "Astoria, NY"));
  check("isLocal: a two-letter code only in capitals", !isLocal({ host: "x.example", title: "Roof repair or replacement", snippet: "" }, "Portland, OR") && isLocal({ host: "x.example", title: "Roofing, Portland OR", snippet: "" }, "Salem, OR"));
  check("isLocal: a spelled-out state in the town works", !isLocal(georgia, "Red Hook, New York") && isLocal({ host: "x.example", title: "Hudson Valley, NY roofers", snippet: "" }, "Red Hook, New York"));
  check("isLocal: no town means no filter", isLocal(georgia, ""));

  const ranked = rankCandidates([{ source: "duckduckgo", results: d }, { source: "bing", results: b }], { own: "http://www.astoria-roofing.example/", want: 3 });
  check("own site and directories skipped", ranked.skipped.own === 1 && ranked.skipped.directories === 1);
  check("one candidate per domain, homepage only", ranked.candidates.map(c => c.url).join(",") === "https://other.example/,https://www.rival.example/,https://third.example/");
  check("a domain both engines return ranks first", ranked.candidates[0].host === "other.example" && ranked.candidates[0].sources.length === 2);
  check("already listed competitors are not found again", rankCandidates([{ source: "bing", results: b }], { own: fixture.url, exclude: ["https://third.example/"] }).skipped.listed === 1);
  check("private hosts never come back", rankCandidates([{ source: "bing", results: [{ url: "http://localhost:4951/", title: "x" }, { url: "http://10.0.0.5/", title: "y" }] }], { own: fixture.url }).candidates.length === 0);

  const calls = [];
  const fake = async url => { calls.push(url); return { ok: true, status: 200, text: /duckduckgo/.test(url) ? ddg : bing }; };
  const found = await discoverCompetitors({ ...fixture, fetcher: fake });
  check("discovery builds the query from the terms and the town", found.queries[0] === "roof repair Astoria, NY");
  check("discovery stops after the first query once three are found", found.queries.length === 1 && calls.length === 2 && found.picked.length === 3);
  check("discovery records what each engine returned", found.engines.length === 2 && found.engines.every(e => e.results === 3));
  const one = await discoverCompetitors({ ...fixture, exclude: ["https://other.example/", "https://third.example/"], want: 1, fetcher: fake });
  check("want caps the picks and skips the listed", one.picked.length === 1 && one.picked[0] === "https://www.rival.example/");
  const none = await discoverCompetitors({ ...fixture, fetcher: async () => ({ ok: true, status: 200, text: "<html>nothing</html>" }) });
  check("no results runs the alt query and says so", none.queries.length === 2 && none.picked.length === 0 && /no usable results/.test(none.note));
  const blockedRun = await discoverCompetitors({ ...fixture, fetcher: async () => ({ ok: true, status: 200, text: '<div class="anomaly-modal">bots</div>' }) });
  check("a bot check is reported as one", /bot check/.test(blockedRun.note) && blockedRun.engines[0].blocked);
  const noTown = await discoverCompetitors({ ...fixture, town: "", html: "<p>We fix roofs.</p>", fetcher: fake });
  check("no town: plain query and a note", noTown.queries[0] === "roof repair" && /not local/.test(noTown.note));
  const farBing = `<li class="b_algo"><h2><a href="https://www.britannica.com/technology/construction">Construction | Britannica</a></h2></li>
    <li class="b_algo"><h2><a href="https://dfpconstruction.example/">DFP Construction | Sandy Springs, GA</a></h2><div class="b_caption"><p class="b_lineclamp2">Atlanta's builder.</p></div></li>`;
  const far = await discoverCompetitors({ ...fixture, fetcher: async url => ({ ok: true, status: /duckduckgo/.test(url) ? 202 : 200, text: /duckduckgo/.test(url) ? "" : farBing }) });
  check("a 202 from duckduckgo is a block, and out-of-town results are not picked", far.engines[0].blocked && far.picked.length === 0 && far.skipped.elsewhere === 1 && /none that say they are in Astoria, NY/.test(far.note));
  const viaLite = await discoverCompetitors({ ...fixture, town: "Red Hook, NY", fetcher: async url => /html\.duckduckgo/.test(url) ? { ok: true, status: 202, text: "" } : /lite\.duckduckgo/.test(url) ? { ok: true, status: 200, text: lite } : { ok: true, status: 200, text: "" } });
  check("when the html page challenges, the lite page answers for duckduckgo", viaLite.engines[0].engine === "duckduckgo-lite" && !viaLite.engines[0].blocked && viaLite.engines[0].results === 2 && viaLite.picked.length === 2 && viaLite.candidates[0].sources[0] === "duckduckgo");
  const six = n => [...Array(6)].map((_, i) => `<li class="b_algo"><h2><a href="https://r${i + 1}.example/">Roofer ${i + 1} Astoria</a></h2></li>`).join("");
  const sixDdg = [...Array(6)].map((_, i) => `<div class="result web-result"><h2 class="result__title"><a class="result__a" href="https://r${i + 1}.example/">Roofer ${i + 1} Astoria</a></h2></div>`).join("");
  // Only the first query gets answers here; the second phrasing would otherwise add to every score.
  const firstOnly = (ddg, bing) => async url => ({ ok: true, status: 200, text: !/roof%20repair/.test(url) ? "" : /duckduckgo/.test(url) ? ddg : bing });
  const both = await discoverCompetitors({ ...fixture, want: 6, fetcher: firstOnly(sixDdg, six()) });
  check("two engines answering: sixth on both is below the bar", both.minScore === 0.9 && both.candidates.length === 6 && both.picked.length === 5);
  const oneEngine = await discoverCompetitors({ ...fixture, want: 6, fetcher: firstOnly(sixDdg, "") });
  check("one engine answering: its top four pass", oneEngine.minScore === 0.25 && oneEngine.picked.length === 4);
  const pageTown = await discoverCompetitors({ ...fixture, town: "", html: "<footer>12 Ditmars Blvd, Astoria, NY 11105</footer>", fetcher: fake });
  check("town read from the page is used and marked", pageTown.town === "Astoria, NY" && pageTown.townSource === "page" && pageTown.queries[0] === "roof repair Astoria, NY");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---------- live check ----------
if (process.argv.includes("--live")) {
  const i = process.argv.indexOf("--live");
  const [url, name, town] = process.argv.slice(i + 1);
  if (!url) { console.error('usage: node discover.mjs --live https://site.com ["Business Name"] ["Town, ST"]'); process.exit(1); }
  // lib.mjs imports this module, so its page miner cannot be imported back here without a
  // deadlock; a light read of the three fields is all the search needs.
  const page = await searchFetch(url);
  if (!page.ok) { console.error("could not fetch " + url); process.exit(1); }
  const title = strip((page.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const h1s = [...page.text.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => strip(m[1]));
  const metaTag = page.text.match(/<meta[^>]+name=["']description["'][^>]*>/i);
  const metaDesc = metaTag ? strip((metaTag[0].match(/content\s*=\s*["']([^"']*)["']/i) || [])[1]) : "";
  console.log(JSON.stringify({ title, h1s, metaDesc: metaDesc.slice(0, 120) }));
  const found = await discoverCompetitors({ url, name: name || "", town: town || "", title, h1s, metaDesc, html: page.text });
  console.log(JSON.stringify({ terms: found.terms, town: found.town, townSource: found.townSource, queries: found.queries, engines: found.engines, skipped: found.skipped, note: found.note }, null, 1));
  console.log("candidates:"); found.candidates.forEach(c => console.log(`  ${c.score.toFixed(2)}  ${c.host}  [${c.sources.join(",")}]  ${c.title.slice(0, 70)}`));
  console.log("picked:", found.picked.join("  "));
}
