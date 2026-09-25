// Audit core: crawl + Lighthouse + rules engine. Shared by the CLI (audit.mjs)
// and the paste-a-website server (server.mjs).
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
                     "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);

export const BRAND = {
  name: "Don · Web & AI for Local Business",
  contact: "don.flo17@gmail.com",
  tagline: "Site, search, and never-missed calls for NYC-area businesses",
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
const decode = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&rsquo;/g, "'").replace(/&nbsp;/g, " ");
const strip = s => decode(s.replace(/\s+/g, " ").trim());
export function mine(html) {
  const get = re => { const m = html.match(re); return m ? strip(m[1]) : null; };
  const all = re => [...html.matchAll(re)];
  const title = get(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDesc = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
                   get(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const h1s = all(/<h1[^>]*>([\s\S]*?)<\/h1>/gi).map(m => strip(m[1].replace(/<[^>]+>/g, "")));
  const imgs = all(/<img\b[^>]*>/gi).map(m => m[0]);
  const imgsWithAlt = imgs.filter(t => /\balt=["'][^"']+["']/i.test(t)).length;
  const tels = all(/href=["']tel:([^"']+)["']/gi).map(m => m[1]);
  const phoneRe = /(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const phones = [...new Set((noScript.match(phoneRe) || []).map(p => p.replace(/\D/g, "").slice(-10)))];
  const ldTypes = all(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)
    .flatMap(m => { try { const j = JSON.parse(m[1]); return [].concat(j).flatMap(x => x["@type"] ? [].concat(x["@type"]) : (x["@graph"] || []).flatMap(g => [].concat(g["@type"] || []))); } catch { return []; } });
  const canonical = /<link[^>]+rel=["']canonical["']/i.test(html);
  const ogTitle = /<meta[^>]+property=["']og:title["']/i.test(html);
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
// Success is judged by the report file, never the exit code: a run that hits a runtime
// error (NO_FCP and the like) still writes its report and exits 1.
// Pinned: 13.5.0 (September 2026) dies at config time with the category filter ("Failed to
// find dependency RobotsTxt for AgentResourceDiscovery") and writes no report, so every
// score came back unmeasured. Move the pin only after a test run against the fixture.
export const LIGHTHOUSE = "lighthouse@13.4.1";
// Until 25 Sep 2026 every run left its Edge running (24 headless browsers from that
// morning's audits alone). Edge relaunches itself when __COMPAT_LAYER is in its
// environment, and processes started from the Claude app on this machine inherit
// __COMPAT_LAYER=DetectorsAppHealth: the msedge.exe that chrome-launcher spawned starts a
// copy with --edge-skip-compat-layer-relaunch and exits. At the end of the run
// chrome-launcher taskkills that dead PID ("not found", silent under --quiet), the real
// browser lives on, and deleting the profile it still holds is the EPERM that used to make
// Lighthouse exit 1 after writing its report. So the variable is dropped, and each run gets
// its own TEMP, which chrome-launcher builds the profile from (<TEMP>\lighthouse.<n>): if a
// browser survives anyway, that path finds it, and only it.
export function runLighthouse(url, outPath, extraFlags = "") {
  let runTmp = null;
  try {
    runTmp = mkdtempSync(join(tmpdir(), "seo-audit-lh-"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(temp|tmp|__compat_layer)$/i.test(k)));
    Object.assign(env, { CHROME_PATH: EDGE, TEMP: runTmp, TMP: runTmp });
    execSync(`npx --yes ${LIGHTHOUSE} "${url}" --quiet --output=json --output-path="${outPath}" ` +
      `--only-categories=performance,seo,accessibility,best-practices ` +
      `${extraFlags} --chrome-flags="--headless=new"`, { stdio: "pipe", timeout: 240000, env });
  } catch {}
  finally {
    if (runTmp) {
      endLighthouseBrowser(runTmp);
      try { rmSync(runTmp, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    }
  }
}
// Ends the Edge a run left behind: every msedge.exe whose command line carries that run's
// own profile path (the browser and each of its helpers do), and nothing at all unless one
// of them is a --headless browser. Not taskkill /T: the leaked browser's parent is gone,
// Windows hands that PID to new processes within minutes, and /T follows parent PIDs. Each
// handle is opened, and its start time checked against the lookup, before anything is
// ended, so no PID can turn into a different process in between. Returns how many it
// ended, which is 0 whenever chrome-launcher's own kill worked.
export function endLighthouseBrowser(runTmp) {
  if (process.platform !== "win32") return 0;
  const ps = `$tag = $env:LH_RUN_PROFILE
$found = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($tag, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
if (-not ($found | Where-Object { $_.CommandLine -match '--headless' })) { 0; exit }
$held = @(foreach ($f in ($found | Sort-Object { $_.CommandLine -match '--type=' })) {
  try {
    $p = [Diagnostics.Process]::GetProcessById([int]$f.ProcessId); [void]$p.Handle
    if ([Math]::Abs(($p.StartTime - $f.CreationDate).TotalMilliseconds) -lt 1) { $p }
  } catch {}
})
foreach ($p in $held) { try { $p.Kill() } catch {} }
foreach ($p in $held) { try { [void]$p.WaitForExit(3000) } catch {} }
$held.Count`;
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")],
      { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LH_RUN_PROFILE: basename(runTmp) + "\\lighthouse." } });
    return parseInt(out.trim(), 10) || 0;
  } catch { return 0; }
}
export function parseLighthouse(outPath) {
  try {
    const lh = JSON.parse(readFileSync(outPath, "utf8"));
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
export function lighthouse(url, outDir) {
  const out = join(outDir, "lighthouse.json");
  runLighthouse(url, out);
  return parseLighthouse(out);
}

// ---------- pdf ----------
export function printPdf(htmlPath, pdfPath) {
  execSync(`"${EDGE}" --headless=new --disable-gpu --no-pdf-header-footer ` +
    `--print-to-pdf="${pdfPath}" "${htmlPath}"`, { stdio: "pipe", timeout: 90000 });
}

// ---------- the audit ----------
const norm = p => (p || "").replace(/\D/g, "").slice(-10);
export async function runAudit(opts, stage = () => {}) {
  const { name, url, gphone, town, competitor, rating, reviews } = opts;
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

  stage("Running Lighthouse — 60 to 120 seconds…");
  const lh = lighthouse(page.finalUrl, outDir);

  let comp = null;
  if (competitor) {
    stage("Reading the competitor…");
    const c = await fetchText(competitor);
    if (c.ok) {
      const cm = mine(c.text);
      const mineKw = new Set(keywords([site.title, site.metaDesc, ...site.h1s].join(" ")));
      const gap = keywords([cm.title, cm.metaDesc, ...cm.h1s].join(" ")).filter(w => !mineKw.has(w)).slice(0, 8);
      comp = { url: competitor, title: cm.title, gap };
    }
  }

  stage("Scoring the findings…");
  const gph = norm(gphone);
  const sitePhones = new Set([...site.phones, ...site.tels.map(norm)]);
  const napMismatch = !!(gph && sitePhones.size > 0 && !sitePhones.has(gph));
  const altPct = site.imgCount ? Math.round(site.imgsWithAlt / site.imgCount * 100) : 100;
  const hasLocalSchema = site.ldTypes.some(t => /LocalBusiness|Organization|HomeAndConstructionBusiness|Restaurant|Dentist|Store|ProfessionalService/i.test(t));
  const year = new Date().getFullYear();
  const staleCopyright = site.copyrightYear && site.copyrightYear <= year - 2 ? site.copyrightYear : null;
  const pagesOk = crawl.pages.filter(p => p.ok);
  const titles = pagesOk.map(p => p.title).filter(Boolean);
  const dupTitles = titles.length !== new Set(titles).size || (site.title && titles.includes(site.title));
  const pagesNoMeta = pagesOk.filter(p => !p.metaDesc).length;

  const F = [];
  const add = (w, title, cost, fix) => F.push({ w, title, cost, fix });
  if (!site.viewport) add(100, "The site does not work on phones",
    "Most local searches happen on a phone. A site with no mobile layout loses those visitors in the first five seconds.",
    "Rebuild mobile-first; every page readable and tappable on a phone.");
  else if (lh.ok && lh.perf < 50) add(85, `The site loads slowly on phones (${lh.perf}/100)`,
    "Slow pages bleed visitors before they see the work; speed is also a Google ranking input.",
    "Compress images, cut render-blocking scripts, target first paint under 2.5s.");
  if (!https) add(90, "The site is not served over HTTPS",
    "Browsers mark it 'Not secure' in the address bar; that label costs trust and rankings.",
    "Install a certificate and force HTTPS site-wide.");
  if (napMismatch) add(95, "Google lists a different phone number than the site",
    "Customers who find the business on Google may be calling a number that isn't the office. Every mismatched call is an invisible lost job.",
    `Align the number everywhere: site says ${[...sitePhones][0]?.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")}, Google says ${gphone}. Pick the canonical one, fix the other.`);
  if (site.tels.length === 0) add(80, "No tap-to-call link anywhere on the page",
    "On a phone, a number you can't tap is a number most people won't dial.",
    "Wrap every phone number in a tel: link; add a sticky call button on mobile.");
  if (lh.ok && lh.perf >= 50 && lh.lcp.n > 4000) add(75, "First paint takes " + lh.lcp.v,
    "Every extra second of load time costs conversions on mobile connections.",
    "Optimize the hero image and defer non-critical scripts.");
  if (!hasLocalSchema) add(70, "Google can't read the business details (no LocalBusiness schema)",
    "Structured data feeds the Google panel, maps, and rich results. Without it the listing works on luck.",
    "Add LocalBusiness JSON-LD: name, address, phone, hours, service area.");
  if (crawl.linkSample.broken > 0) add(68, `${crawl.linkSample.broken} broken link${crawl.linkSample.broken > 1 ? "s" : ""} in a ${crawl.linkSample.checked}-link sample`,
    "Broken links read as neglect to visitors and to Google alike.",
    "Fix or remove every dead link; re-check quarterly.");
  if (!site.title || site.title.length < 15 || site.title.length > 65) add(60, "The page title is " + (!site.title ? "missing" : site.title.length < 15 ? "too short to rank" : "too long and gets cut off"),
    "The title is the headline Google shows; a weak one loses clicks to whoever wrote a better one.",
    "Write a 50–60 character title: service + town + business name.");
  if (!site.metaDesc) add(58, "No meta description on the homepage",
    "Google improvises the snippet under the listing; improvised snippets don't sell.",
    "Write a 150-character description with the offer and the town in it.");
  if (pagesNoMeta > 0) add(56, `${pagesNoMeta} of ${pagesOk.length} inner pages have no meta description`,
    "Every page is a possible entry from search; blank snippets waste those doors.",
    "Write one per page: what's on it, for whom, where.");
  if (comp && comp.gap.length >= 3) add(55, "A competitor ranks for words this site never says",
    "Search can only match words that exist on the page.",
    "Work these into real page copy: " + comp.gap.slice(0, 6).join(", ") + ".");
  if (dupTitles) add(52, "Multiple pages share the same title",
    "Duplicate titles make pages compete with each other in search instead of covering more ground.",
    "Give every page a unique title for its own service or topic.");
  if (staleCopyright) add(50, `The footer says © ${staleCopyright}`,
    "A years-old copyright line tells visitors nobody is home.",
    "Update the year (or generate it automatically) — thirty-second fix.");
  if (!site.analytics) add(48, "No analytics installed",
    "Nobody is measuring what visitors do, so every marketing decision is a guess.",
    "Install GA4 (free) and wire call/quote clicks as conversions.");
  if (!hasSitemap && !hasRobots) add(45, "No sitemap.xml or robots.txt",
    "Without a sitemap, Google discovers pages by accident.",
    "Publish both and submit the sitemap in Search Console.");
  if (altPct < 50 && site.imgCount > 3) add(40, `Only ${altPct}% of images have alt text`,
    "Images without descriptions are invisible to search and to screen readers.",
    "Describe every photo: service + location beats 'IMG_4021'.");
  if (!site.ogTitle) add(35, "No social preview tags",
    "Shared links show up bare on Facebook, iMessage, and WhatsApp — no image, no pitch.",
    "Add Open Graph title, description, and a real photo.");
  if (!site.favicon) add(25, "No favicon",
    "The browser-tab icon is small trust; a blank one reads unfinished.",
    "Add a favicon from the logo.");
  F.sort((a, b) => b.w - a.w);

  const sev = w => w >= 85 ? "critical" : w >= 65 ? "high" : w >= 45 ? "medium" : "low";
  const data = { name, url: page.finalUrl, town, date: new Date().toISOString().slice(0, 10),
    rating, reviews, gphone, lighthouse: lh,
    site: { ...site, https, hasSitemap, hasRobots, altPct, hasLocalSchema },
    crawl, napMismatch, comp,
    findings: F.map(f => ({ ...f, sev: sev(f.w) })),
    fixes: F.slice(0, 5), slug, outDir };
  writeFileSync(join(outDir, "audit.json"), JSON.stringify(data, null, 2));
  return data;
}
