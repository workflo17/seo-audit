// The owner-only full report. Inherits the client report's visual system (CSS from
// report.mjs) and adds the deep sections: technical health, the whole crawl, link
// health, content inventory, local presence, a 90-day plan, and raw appendices.
// This document is the working file: it says what is wrong and what to do about it,
// at a level of detail no prospect gets from the free teaser.
import { BRAND } from "./lib.mjs";
import { CSS as BASE_CSS } from "./report.mjs";

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const PRO_CSS = BASE_CSS + `
  /* Letter margins move to @page so long appendix tables can flow onto extra sheets. */
  @page{size:letter; margin:.5in}
  .page{width:auto; min-height:9.6in; padding:0; margin:0}
  @media screen{
    body{background:#E9EBED; padding:24px 0}
    .page{width:7.5in; padding:.45in .5in; margin:0 auto 24px; background:#fff}
  }
  .prohead{display:flex; justify-content:space-between; align-items:center; background:#1B1F23; color:#fff;
           border-radius:8px; padding:8px 14px; margin:10px 0 4px}
  .prohead b{font:700 12px Bahnschrift,sans-serif; text-transform:uppercase; letter-spacing:2px}
  .prohead span{font:10.5px Consolas,monospace; color:#C6CCD3}
  .hero{display:flex; gap:18px; align-items:stretch; margin:14px 0}
  .heroScore{width:150px; border:2px solid #1B1F23; border-radius:10px; text-align:center; padding:10px 6px}
  .heroScore b{display:block; font:700 52px/1 Bahnschrift,sans-serif}
  .heroScore span{font-size:9.5px; text-transform:uppercase; letter-spacing:1.2px; color:#5A6470}
  .bars{flex:1; display:flex; flex-direction:column; justify-content:center; gap:7px}
  .bar{display:grid; grid-template-columns:88px 1fr 34px; align-items:center; gap:8px; font-size:11px}
  .bar i{font-style:normal; text-transform:uppercase; letter-spacing:1px; color:#5A6470; font-size:9.5px}
  .track{height:9px; background:#EEF0F2; border-radius:5px; overflow:hidden}
  .track div{height:100%; border-radius:5px}
  .bar b{text-align:right; font:700 12px Bahnschrift,sans-serif}
  .stats{display:flex; gap:8px; margin:10px 0}
  .stat{flex:1; border:1px solid #DDE1E6; border-radius:8px; padding:6px 8px}
  .stat b{display:block; font:700 19px Bahnschrift,sans-serif}
  .stat span{font-size:9px; text-transform:uppercase; letter-spacing:.9px; color:#5A6470}
  table.dense{font-size:10.5px}
  table.dense th{padding:3px 6px 3px 0}
  table.dense td{padding:3px 6px 3px 0}
  .dot{display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px}
  .dot.g{background:#2F9E44}.dot.r{background:#C92A2A}.dot.y{background:#B4690E}.dot.n{background:#C6CCD3}
  .ev{margin:4px 0 0; padding-left:14px; font:10.5px Consolas,monospace; color:#5A6470}
  .ev li{margin:1px 0; word-break:break-all}
  .plan{display:flex; gap:10px; margin:8px 0}
  .plan > div{flex:1; border:1px solid #DDE1E6; border-radius:8px; padding:8px 10px}
  .plan h4{margin:0 0 4px; font:700 10px Bahnschrift,sans-serif; text-transform:uppercase; letter-spacing:1.2px; color:#E8590C}
  .plan ul{margin:0; padding-left:14px; font-size:10.5px}
  .plan li{margin:2px 0}
  .note{font-size:10.5px; color:#5A6470; margin:6px 0}
  .owner{position:absolute; top:.18in; right:0; font:700 8.5px Bahnschrift,sans-serif; letter-spacing:1.6px;
         text-transform:uppercase; color:#98A2AD}
`;

const clr = v => v >= 90 ? "#2F9E44" : v >= 50 ? "#B4690E" : "#C92A2A";
const cls = v => v >= 90 ? "g" : v >= 50 ? "y" : "r";
const head = (d, sub) => `<header><div class="brand">${esc(BRAND.name)}<small>Full technical audit, internal working copy</small></div><span class="date">${d.date}</span></header>
  <span class="owner">owner copy</span>${sub ? `<h1>${esc(d.name)}</h1><div class="sub">${sub}</div>` : ""}`;
const foot = (d, n, of) => `<footer><div><b>${esc(BRAND.contact)}</b> · ${d.crawl.pages.length} pages crawled · ${d.crawl.linksChecked} links checked</div><div>${esc(d.name)}</div></footer><span class="pageno">${n} / ${of}</span>`;
const sec = t => `<div class="prohead"><b>${t}</b><span></span></div>`;
const yn = (ok, good, bad) => `<span class="dot ${ok === null ? "n" : ok ? "g" : "r"}"></span>${ok === null ? "not measured" : ok ? good : bad}`;
const rows = a => a.length ? a.join("") : `<tr><td colspan="9" class="muted">nothing found</td></tr>`;
const li = a => a.length ? `<ul class="ev">${a.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "";

function verdict(d) {
  const c = d.findings.filter(f => f.sev === "critical").length;
  const h = d.findings.filter(f => f.sev === "high").length;
  const s = d.scores;
  const worst = Object.entries({ speed: s.speed, content: s.content, technical: s.tech, local: s.local, trust: s.trust })
    .sort((a, b) => a[1] - b[1])[0];
  return `<div class="verdict"><b>Where this site actually stands.</b> Overall health ${s.overall}/100 across ${d.crawl.pages.length} crawled pages.
    ${c + h === 0 ? "Nothing critical is broken; the work below is sharpening." :
      `${c} critical and ${h} high-impact issue${c + h === 1 ? "" : "s"} sit between a searcher and the phone ringing.`}
    The weakest area is <b>${worst[0]}</b> at ${worst[1]}/100${d.links.brokenInternal ? `, and ${d.links.brokenInternal} internal link${d.links.brokenInternal > 1 ? "s are" : " is"} dead` : ""}.
    Every item in this report is checked, not guessed: the evidence line under each finding names the page it came from.</div>`;
}

function planBuckets(d) {
  const quick = d.findings.filter(f => /15 minutes|30 minutes|1 hour/.test(f.effort));
  const month = d.findings.filter(f => /2 hours|half a day/.test(f.effort));
  const later = d.findings.filter(f => /day/.test(f.effort) && !/half a day/.test(f.effort));
  return { quick, month, later };
}

export function buildProReport(d) {
  const lh = d.lighthouse, lhd = d.lighthouseDesktop, s = d.scores, pages = d.crawl.pages;
  const sevCount = k => d.findings.filter(f => f.sev === k).length;
  const bar = (label, v) => `<div class="bar"><i>${label}</i><div class="track"><div style="width:${v}%;background:${clr(v)}"></div></div><b class="${cls(v)}">${v}</b></div>`;
  const met = (name, a, b, why) => `<tr><td><b>${name}</b></td><td class="${a && a.s !== null ? cls(a.s * 100) : ""}">${a && a.v ? esc(a.v) : "-"}</td><td class="${b && b.s !== null ? cls(b.s * 100) : ""}">${b && b.v ? esc(b.v) : "-"}</td><td class="muted">${why}</td></tr>`;
  const { quick, month, later } = planBuckets(d);

  const page1 = `<div class="page">${head(d, `${d.town ? esc(d.town) + " · " : ""}${esc(d.url)}${d.rating ? ` · ${esc(d.rating)}★${d.reviews ? ` (${esc(d.reviews)})` : ""}` : ""}`)}
    ${verdict(d)}
    <div class="hero">
      <div class="heroScore"><b class="${cls(s.overall)}">${s.overall}</b><span>site health</span></div>
      <div class="bars">
        ${bar("Speed", s.speed)}${bar("Content", s.content)}${bar("Technical", s.tech)}${bar("Local", s.local)}${bar("Trust", s.trust)}
      </div>
    </div>
    <div class="stats">
      <div class="stat"><b>${pages.length}</b><span>pages crawled</span></div>
      <div class="stat"><b>${d.crawl.linksChecked}</b><span>links checked</span></div>
      <div class="stat"><b class="${d.links.brokenInternal ? "r" : "g"}">${d.links.brokenInternal + d.links.brokenExternal}</b><span>dead links</span></div>
      <div class="stat"><b>${d.content.totals.words.toLocaleString()}</b><span>words of copy</span></div>
      <div class="stat"><b class="r">${sevCount("critical")}</b><span>critical</span></div>
      <div class="stat"><b class="y">${sevCount("high")}</b><span>high</span></div>
      <div class="stat"><b>${d.findings.length}</b><span>total findings</span></div>
    </div>
    <h2>The five that move money first</h2>
    <ol class="fixes">${d.fixes.map(f => `<li><div><b>${esc(f.title)}</b><div class="cost">${esc(f.cost)}</div><div class="fix"><em>Fix (${esc(f.effort)}):</em> ${esc(f.fix)}</div></div></li>`).join("")}</ol>
    <h2>The plan, by how long it takes</h2>
    <div class="plan">
      <div><h4>Quick wins · under an hour each</h4><ul>${quick.slice(0, 8).map(f => `<li>${esc(f.title)}</li>`).join("") || "<li>none</li>"}</ul></div>
      <div><h4>This month · hours to a day</h4><ul>${month.slice(0, 8).map(f => `<li>${esc(f.title)}</li>`).join("") || "<li>none</li>"}</ul></div>
      <div><h4>Bigger builds · a day or more</h4><ul>${later.slice(0, 8).map(f => `<li>${esc(f.title)}</li>`).join("") || "<li>none</li>"}</ul></div>
    </div>
    ${foot(d, 1, "N")}
  </div>`;

  const page2 = `<div class="page">${head(d)}
    ${sec("Speed on mobile and desktop, measured")}
    <div class="row">
      <div class="sc"><b class="${lh.ok ? cls(lh.perf) : ""}">${lh.ok ? lh.perf : "-"}</b><span>Speed · mobile</span></div>
      <div class="sc"><b class="${lhd.ok ? cls(lhd.perf) : ""}">${lhd.ok ? lhd.perf : "-"}</b><span>Speed · desktop</span></div>
      <div class="sc"><b class="${lh.ok ? cls(lh.seo) : ""}">${lh.ok ? lh.seo : "-"}</b><span>SEO</span></div>
      <div class="sc"><b class="${lh.ok ? cls(lh.a11y) : ""}">${lh.ok ? lh.a11y : "-"}</b><span>Accessibility</span></div>
      <div class="sc"><b class="${lh.ok ? cls(lh.bp) : ""}">${lh.ok ? lh.bp : "-"}</b><span>Best practices</span></div>
    </div>
    <table><tr><th>Measure</th><th>Mobile</th><th>Desktop</th><th>What it means for a customer</th></tr>
      ${met("First content appears", lh.fcp, lhd.fcp, "How long the screen stays blank.")}
      ${met("Main content loaded", lh.lcp, lhd.lcp, "When the page feels 'there'. Google's line is 2.5s.")}
      ${met("Page responsiveness", lh.tbt, lhd.tbt, "How long taps get ignored while scripts run.")}
      ${met("Layout stability", lh.cls, lhd.cls, "Whether buttons jump around as things load.")}
      ${met("Speed index", lh.si, lhd.si, "How quickly the page looks complete.")}
      ${met("Server response", lh.ttfb, lhd.ttfb, "Dead time before anything can start.")}
    </table>
    ${lh.ok && lh.opportunities.length ? `<h3>Biggest wins by time saved (mobile)</h3>
      <table class="dense"><tr><th>Change</th><th>Saving</th></tr>${lh.opportunities.map(o => `<tr><td>${esc(o.title)}</td><td>${esc(o.save)}</td></tr>`).join("")}</table>` : ""}
    ${sec("Transport: what the server does before a pixel is drawn")}
    <table class="dense"><tr><th>Check</th><th>Result</th><th>Why it matters</th></tr>
      <tr><td>Time to first byte</td><td class="${d.tech.ttfbMs > 800 ? "r" : d.tech.ttfbMs > 400 ? "y" : "g"}">${d.tech.ttfbMs ?? "-"} ms</td><td class="muted">Under 400ms is healthy; over 800ms is a hosting problem.</td></tr>
      <tr><td>HTTP version</td><td>${esc(d.tech.httpVersion || "-")}</td><td class="muted">HTTP/2+ loads assets in parallel.</td></tr>
      <tr><td>Compression</td><td>${yn(d.tech.compressed, esc(d.tech.headers.encoding || "on"), "off, so visitors download full-size files")}</td><td class="muted">gzip or brotli cuts transfer several times over.</td></tr>
      <tr><td>Cache policy</td><td>${esc(d.tech.headers.cache || "none sent")}</td><td class="muted">Repeat visits should not re-download everything.</td></tr>
      <tr><td>Server</td><td>${esc(d.tech.headers.server || "not disclosed")}</td><td class="muted">Tells you what stack any fix has to land in.</td></tr>
    </table>
    ${(() => { const slow = pages.filter(p => p.ttfbMs && p.ttfbMs > 800); return slow.length ? `<h3>Pages slower than 800ms to first byte</h3>
      <table class="dense"><tr><th>Page</th><th>TTFB</th><th>Bytes</th></tr>${slow.slice(0, 12).map(p => `<tr><td>${esc(p.path)}</td><td class="r">${p.ttfbMs} ms</td><td>${Math.round(p.bytes / 1024)} KB</td></tr>`).join("")}</table>` : ""; })()}
    ${foot(d, 2, "N")}
  </div>`;

  const r = d.robots;
  const page3 = `<div class="page">${head(d)}
    ${sec("Technical health")}
    <table><tr><th>Check</th><th>Status</th><th>Detail</th></tr>
      <tr><td>HTTPS</td><td>${yn(d.site.https, "served over https", "NOT secure")}</td><td class="muted">${esc(d.url)}</td></tr>
      <tr><td>http → https redirect</td><td>${yn(d.tech.httpsForced, "forced", "insecure copy still live")}</td><td class="muted">Two live copies split ranking signals.</td></tr>
      <tr><td>www / non-www unified</td><td>${yn(d.tech.hostUnified, "one canonical host", "both hosts answer separately")}</td><td class="muted">Pick one, 301 the other.</td></tr>
      <tr><td>Missing page returns 404</td><td>${yn(d.tech.notFoundStatus === null ? null : d.tech.notFoundStatus === 404 || d.tech.notFoundStatus === 410, "correct 404", "soft 404: HTTP " + d.tech.notFoundStatus)}</td><td class="muted">Soft 404s hide broken links and pollute the index.</td></tr>
      <tr><td>robots.txt</td><td>${yn(!!r, "present", "missing")}</td><td class="muted">${r ? `${r.disallow.length} disallow rule${r.disallow.length === 1 ? "" : "s"}, ${r.sitemaps.length} sitemap line${r.sitemaps.length === 1 ? "" : "s"}` : "crawlers get no guidance"}</td></tr>
      <tr><td>XML sitemap</td><td>${yn(d.sitemap.found, `${d.sitemap.count} URLs`, "missing")}</td><td class="muted">${d.sitemap.sources.filter(x => x.ok).map(x => esc(x.url)).join(", ") || "none found at the usual paths"}</td></tr>
      <tr><td>Canonical tags</td><td>${yn(pages.filter(p => p.canonicalHref).length >= pages.length / 2, `${pages.filter(p => p.canonicalHref).length}/${pages.length} pages`, `only ${pages.filter(p => p.canonicalHref).length}/${pages.length} pages`)}</td><td class="muted">Stops parameter and slash variants becoming duplicates.</td></tr>
      <tr><td>Indexable pages</td><td>${yn(d.content.noindexed.length === 0, "all crawled pages indexable", `${d.content.noindexed.length} marked noindex`)}</td><td class="muted">${d.content.noindexed.slice(0, 4).map(esc).join(", ")}</td></tr>
      <tr><td>Mixed content</td><td>${yn(pages.every(p => !(p.mixed || []).length), "all assets https", (n => `${n} page${n === 1 ? "" : "s"} load${n === 1 ? "s" : ""} http:// assets`)(pages.filter(p => (p.mixed || []).length).length))}</td><td class="muted">Browsers block or warn on these.</td></tr>
      <tr><td>Mobile viewport</td><td>${yn(pages.every(p => p.viewport !== false), "every page", `${pages.filter(p => p.viewport === false).length} pages without it`)}</td><td class="muted">No viewport means no mobile layout at all.</td></tr>
      <tr><td>HSTS</td><td>${yn(!!d.tech.headers.hsts, "set", "not set")}</td><td class="muted">${esc((d.tech.headers.hsts || "").slice(0, 60))}</td></tr>
      <tr><td>X-Content-Type-Options</td><td>${yn(!!d.tech.headers.xcto, "nosniff", "not set")}</td><td class="muted">One-line hardening most hosts leave off.</td></tr>
      <tr><td>Content-Security-Policy</td><td>${yn(!!d.tech.headers.csp, "present", "not set")}</td><td class="muted">Optional for a brochure site; noted for completeness.</td></tr>
    </table>
    ${d.content.orphans.length ? `<h3>Orphan pages: in the sitemap, linked from nowhere</h3>${li(d.content.orphans.slice(0, 12))}` : ""}
    ${d.crawl.skippedByRobots.length ? `<h3>Skipped because robots.txt disallows them</h3>${li(d.crawl.skippedByRobots.slice(0, 8).map(x => `${x.url} (rule ${x.rule})`))}` : ""}
    ${r && r.disallow.length ? `<h3>robots.txt rules in force</h3>${li(r.disallow.slice(0, 12).map(x => "Disallow: " + x))}` : ""}
    ${foot(d, 3, "N")}
  </div>`;

  const c = d.content;
  const page4 = `<div class="page">${head(d)}
    ${sec("Content and on-page")}
    <div class="stats">
      <div class="stat"><b>${c.totals.pages}</b><span>pages</span></div>
      <div class="stat"><b>${c.totals.words.toLocaleString()}</b><span>words total</span></div>
      <div class="stat"><b>${Math.round(c.totals.words / Math.max(1, c.totals.pages))}</b><span>words / page</span></div>
      <div class="stat"><b>${c.totals.images}</b><span>images</span></div>
      <div class="stat"><b class="${c.totals.altPct >= 60 ? "g" : "r"}">${c.totals.altPct}%</b><span>with alt text</span></div>
    </div>
    <table class="dense"><tr><th>Issue</th><th>Pages</th><th>Where</th></tr>
      <tr><td>No title tag</td><td class="${c.noTitle.length ? "r" : "g"}">${c.noTitle.length}</td><td class="muted">${c.noTitle.slice(0, 5).map(esc).join(", ")}</td></tr>
      <tr><td>Duplicate titles</td><td class="${c.dupTitles.length ? "r" : "g"}">${c.dupTitles.length}</td><td class="muted">${c.dupTitles.slice(0, 3).map(([t, n]) => `${n}× ${esc(String(t).slice(0, 40))}`).join(" · ")}</td></tr>
      <tr><td>No meta description</td><td class="${c.noMeta.length ? "r" : "g"}">${c.noMeta.length}</td><td class="muted">${c.noMeta.slice(0, 5).map(esc).join(", ")}</td></tr>
      <tr><td>Duplicate meta descriptions</td><td class="${c.dupMetas.length ? "r" : "g"}">${c.dupMetas.length}</td><td class="muted">${c.dupMetas.slice(0, 2).map(([t, n]) => `${n}× ${esc(String(t).slice(0, 40))}`).join(" · ")}</td></tr>
      <tr><td>No H1</td><td class="${c.noH1.length ? "r" : "g"}">${c.noH1.length}</td><td class="muted">${c.noH1.slice(0, 5).map(esc).join(", ")}</td></tr>
      <tr><td>Thin pages (under 300 words)</td><td class="${c.thin.length ? "r" : "g"}">${c.thin.length}</td><td class="muted">${c.thin.slice(0, 5).map(t => `${esc(t.path)} (${t.words}w)`).join(", ")}</td></tr>
      ${c.townCoverage !== null ? `<tr><td>Pages naming the service area</td><td class="${c.townCoverage >= c.totals.pages * 0.3 ? "g" : "r"}">${c.townCoverage}/${c.totals.pages}</td><td class="muted">${esc(d.town || "")}</td></tr>` : ""}
    </table>
    ${d.competitors.length ? `${sec("Competitors")}
    <table class="dense"><tr><th>Site</th><th>Words on the page</th><th>Schema</th><th>Words they lead with that this site never says</th></tr>
      ${rows(d.competitors.map(x => x.ok
        ? `<tr><td>${esc(x.url)}</td><td>${x.words}</td><td>${esc((x.schema || []).slice(0, 3).join(", ") || "none")}</td><td>${esc((x.gap || []).slice(0, 10).join(", ") || "no gap found")}</td></tr>`
        : `<tr><td>${esc(x.url)}</td><td colspan="3" class="r">could not be read</td></tr>`))}
    </table>` : ""}
    ${sec("Local presence")}
    <table class="dense"><tr><th>Signal</th><th>Status</th></tr>
      <tr><td>Phone numbers found on the site</td><td>${d.local.phones.map(esc).join(", ") || "none"}</td></tr>
      ${d.gphone ? `<tr><td>Number Google shows</td><td class="${d.local.napMismatch ? "r" : "g"}">${esc(d.gphone)}${d.local.napMismatch ? ", DIFFERENT from the site" : ", matches"}</td></tr>` : ""}
      <tr><td>Tap-to-call coverage</td><td class="${d.local.telPages >= c.totals.pages / 2 ? "g" : "r"}">${d.local.telPages}/${c.totals.pages} pages</td></tr>
      <tr><td>Street address in the copy</td><td>${yn(d.local.hasAddress, "present", "not found")}</td></tr>
      <tr><td>Opening hours</td><td>${yn(d.local.hasHours, "published", "not found")}</td></tr>
      <tr><td>Map embed</td><td>${yn(d.local.hasMap, "present", "none")}</td></tr>
      <tr><td>Contact form</td><td>${yn(d.local.hasForm, "present", "none found")}</td></tr>
      <tr><td>Business schema</td><td class="${d.site.hasLocalSchema ? "g" : "r"}">${d.site.hasLocalSchema ? esc(d.local.schemaTypes.join(", ")) : "none, so Google is guessing"}</td></tr>
      <tr><td>Analytics</td><td>${yn(!!d.site.analytics, "installed", "nothing measuring visits")}</td></tr>
    </table>
    ${foot(d, 4, "N")}
  </div>`;

  const broken = d.links.broken;
  const page5 = `<div class="page">${head(d)}
    ${sec("Link health")}
    <p class="note">${d.crawl.internalLinksFound} internal and ${d.crawl.externalLinksFound} external link targets were found; ${d.crawl.linksChecked} were requested individually. A status of 0 means the host never answered (DNS, TLS or timeout), which reads to a visitor exactly like a dead link.</p>
    <h3>Broken internal links</h3>
    <table class="dense"><tr><th>Status</th><th>Target</th><th>Linked from</th></tr>
      ${rows(broken.filter(l => l.kind === "internal").slice(0, 40).map(l => `<tr><td class="r">${l.status || "no answer"}</td><td>${esc(l.url)}</td><td class="muted">${esc(l.from)}</td></tr>`))}
    </table>
    <h3>Broken outbound links</h3>
    <table class="dense"><tr><th>Status</th><th>Target</th><th>Linked from</th></tr>
      ${rows(broken.filter(l => l.kind === "external").slice(0, 25).map(l => `<tr><td class="r">${l.status || "no answer"}</td><td>${esc(l.url)}</td><td class="muted">${esc(l.from)}</td></tr>`))}
    </table>
    ${(d.links.blocked || []).length ? `<h3>Refused the crawler: check these by hand, usually fine</h3>
    <p class="note">401, 403 and 429 normally mean the far end blocks bots rather than that the link is dead. These are excluded from the broken counts above.</p>
    <table class="dense"><tr><th>Status</th><th>Target</th><th>Linked from</th></tr>
      ${d.links.blocked.slice(0, 20).map(l => `<tr><td class="y">${l.status}</td><td>${esc(l.url)}</td><td class="muted">${esc(l.from)}</td></tr>`).join("")}
    </table>` : ""}
    ${foot(d, 5, "N")}
  </div>`;

  const page6 = `<div class="page">${head(d)}
    ${sec("Every finding, ranked")}
    <table class="dense"><tr><th>Priority</th><th>Area</th><th>Finding</th><th>The fix</th><th>Effort</th></tr>
      ${d.findings.map(f => `<tr>
        <td><span class="pill p-${f.sev}">${f.sev}</span></td>
        <td class="muted">${f.cat}</td>
        <td><b>${esc(f.title)}</b><br><span class="muted">${esc(f.cost)}</span>${li(f.evidence)}</td>
        <td>${esc(f.fix)}</td><td class="muted">${esc(f.effort)}</td></tr>`).join("")}
    </table>
    ${foot(d, 6, "N")}
  </div>`;

  const page7 = `<div class="page">${head(d)}
    ${sec("Appendix: every page crawled")}
    <table class="dense"><tr><th>Path</th><th>Status</th><th>TTFB</th><th>Words</th><th>Title</th><th>Meta</th><th>H1</th><th>Img alt</th><th>Links out</th></tr>
      ${rows(pages.map(p => `<tr>
        <td>${esc((p.path || p.url).slice(0, 46))}</td>
        <td class="${p.status >= 400 || !p.status ? "r" : "g"}">${p.status || "-"}</td>
        <td class="${p.ttfbMs > 800 ? "r" : ""}">${p.ttfbMs ?? "-"}</td>
        <td class="${p.wordCount < 300 ? "r" : ""}">${p.wordCount ?? "-"}</td>
        <td class="${!p.title ? "r" : p.titleLen < 25 || p.titleLen > 65 ? "y" : "g"}">${p.title ? p.titleLen : "none"}</td>
        <td class="${!p.metaDesc ? "r" : p.metaLen < 70 || p.metaLen > 165 ? "y" : "g"}">${p.metaDesc ? p.metaLen : "none"}</td>
        <td class="${(p.h1s || []).length === 1 ? "g" : "r"}">${(p.h1s || []).length}</td>
        <td>${p.imgCount ? Math.round((p.imgsWithAlt / p.imgCount) * 100) + "%" : "-"}</td>
        <td class="muted">${p.internalOut ?? "-"}/${p.externalOut ?? "-"}</td></tr>`))}
    </table>
    <p class="note">Title and Meta columns show character counts: red means missing, amber means outside the range Google displays cleanly (25-65 and 70-165). Links out is internal/external.</p>
    ${foot(d, 7, "N")}
  </div>`;

  const page8 = `<div class="page">${head(d)}
    ${sec("Appendix: Lighthouse audits that failed (mobile)")}
    <table class="dense"><tr><th>Audit</th><th>Detail</th></tr>
      ${rows((lh.failures || []).slice(0, 60).map(f => `<tr><td>${esc(f.title)}</td><td class="muted">${esc(f.display || "")}</td></tr>`))}
    </table>
    ${sec("How this audit was run")}
    <p class="note">Crawl: sitemap-seeded breadth-first from ${esc(d.url)}, ${d.crawl.pagesCrawled} URLs fetched of ${d.crawl.discovered} discovered, capped at ${d.maxPages}, 120ms between requests per worker, robots.txt disallow rules honoured.
    Speed: Google Lighthouse via headless Edge, mobile emulation and the desktop preset, run back to back on the homepage.
    Transport facts (TTFB, HTTP version, compression, headers) come from a direct curl probe, not from the browser.
    Links: every internal target not already crawled, plus up to 60 outbound targets, requested individually.
    Nothing here is estimated. Every number above came from a request made on ${d.date}.</p>
    ${foot(d, 8, "N")}
  </div>`;

  const html = [page1, page2, page3, page4, page5, page6, page7, page8].join("");
  const total = 8;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.name)} · full technical audit</title><style>${PRO_CSS}</style></head><body>${html.replace(/\/ N<\/span>/g, `/ ${total}</span>`)}</body></html>`;
}

// One page for the clipboard: what to do, in order, with the effort next to it.
export function buildProChecklist(d) {
  const { quick, month, later } = planBuckets(d);
  const block = (title, list) => `<h3>${title}</h3><table class="dense"><tr><th>#</th><th>Do this</th><th>Effort</th><th>Why</th></tr>
    ${list.length ? list.map((f, i) => `<tr><td>${i + 1}</td><td><b>${esc(f.title)}</b><br>${esc(f.fix)}</td><td>${esc(f.effort)}</td><td class="muted">${esc(f.cost)}</td></tr>`).join("")
      : `<tr><td colspan="4" class="muted">nothing in this bucket</td></tr>`}</table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.name)} · work checklist</title><style>${PRO_CSS}</style></head><body>
  <div class="page">${head(d, `${esc(d.url)} · health ${d.scores.overall}/100 · ${d.findings.length} findings`)}
    ${block("Quick wins, under an hour each", quick)}
    ${block("This month: hours to a day", month)}
    ${block("Bigger builds: a day or more", later)}
    ${foot(d, 1, 1)}
  </div></body></html>`;
}
