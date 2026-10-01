// The owner-only full report, plus the client-safe version of the same evidence.
// Both inherit the client teaser's visual system (CSS from report.mjs) and add the deep
// sections: technical health, the whole crawl, link health, content inventory, local
// presence, head-to-head against competitors, a plan by effort, and (owner copy only)
// raw appendices. buildClientReport strips the run-internals pages and the "owner copy"
// marks so the same underlying findings can go straight to the person who hired us.
import { BRAND } from "./lib.mjs";
import { CSS as BASE_CSS } from "./report.mjs";
import { compare, standing, host } from "./compete.mjs";

// Which competitors a search found, with the query, and what the search could not do.
function foundLine(discovery, comps) {
  if (!discovery) return "";
  const found = (comps || []).filter(x => x.ok && x.found).map(x => host(x.url));
  const bits = [];
  if (found.length) bits.push(`${found.join(", ")} ${found.length === 1 ? "was" : "were"} found by searching for "${discovery.queries[0]}".`);
  if (discovery.note) bits.push(discovery.note);
  return bits.length ? `<p class="note">${esc(bits.join(" "))}</p>` : "";
}

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
  .hero{display:flex; gap:18px; align-items:flex-start; margin:14px 0}
  .heroShot{width:92px; flex-shrink:0}
  .heroShot img{width:100%; display:block; border:1px solid #DDE1E6; border-radius:6px}
  .heroScore{width:150px; border:2px solid #1B1F23; border-radius:10px; text-align:center; padding:10px 6px}
  .heroScore b{display:block; font:700 52px/1 Bahnschrift,sans-serif}
  .heroScore span{font-size:9.5px; text-transform:uppercase; letter-spacing:1.2px; color:#5A6470}
  .bars{flex:1; display:flex; flex-direction:column; justify-content:center; gap:7px}
  .bar{display:grid; grid-template-columns:88px 1fr 64px; align-items:center; gap:8px; font-size:11px}
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
  .runnote{border-left:4px solid #B4690E; background:#FDF3EC; border-radius:0 8px 8px 0; padding:8px 14px; margin:10px 0; font-size:11.5px}
  .runnote b{display:block; margin-bottom:2px}
  .runnote ul{margin:2px 0 0; padding-left:16px}
  .runnote li{margin:1px 0}
  .histnote{border:1px solid #DDE1E6; border-radius:8px; padding:6px 12px; margin:8px 0; font-size:11.5px; color:#3D4650}
  .warn{border-left:4px solid #C92A2A; background:#FBEAEA; border-radius:0 8px 8px 0; padding:8px 14px; margin:8px 0; font-size:11.5px; font-weight:700; color:#C92A2A}
  .best{font-weight:700}
  .owner{position:absolute; top:.18in; right:0; font:700 8.5px Bahnschrift,sans-serif; letter-spacing:1.6px;
         text-transform:uppercase; color:#98A2AD}
  @media print{
    tr, li, .finding, .card{break-inside:avoid; page-break-inside:avoid}
    thead{display:table-header-group}
  }
`;

const clr = v => v >= 90 ? "#2F9E44" : v >= 50 ? "#B4690E" : "#C92A2A";
const cls = v => v >= 90 ? "g" : v >= 50 ? "y" : "r";
const head = (d, sub, client) => `<header><div class="brand">${esc(BRAND.name)}<small>${client ? "Full site audit" : "Full technical audit, internal working copy"}</small></div><span class="date">${d.date}</span></header>
  ${client ? "" : `<span class="owner">owner copy</span>`}${sub ? `<h1>${esc(d.name)}</h1><div class="sub">${sub}</div>` : ""}`;
const foot = (d, section) => `<footer><div><b>${esc(BRAND.contact)}</b> · ${d.crawl.pages.length} pages crawled · ${d.crawl.linksChecked} links checked</div><div>${esc(d.name)}</div></footer><span class="pageno">${esc(section)}</span>`;
const sec = t => `<div class="prohead"><b>${t}</b><span></span></div>`;
const yn = (ok, good, bad) => `<span class="dot ${ok === null ? "n" : ok ? "g" : "r"}"></span>${ok === null ? "not measured" : ok ? good : bad}`;
const rows = (a, cols = 9) => a.length ? a.join("") : `<tr><td colspan="${cols}" class="muted">nothing found</td></tr>`;
const li = a => a.length ? `<ul class="ev">${a.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
const bar = (label, v) => v === null
  ? `<div class="bar"><i>${label}</i><div class="track"></div><b class="muted">not scored</b></div>`
  : `<div class="bar"><i>${label}</i><div class="track"><div style="width:${v}%;background:${clr(v)}"></div></div><b class="${cls(v)}">${v}</b></div>`;
const met = (name, a, b, why) => `<tr><td><b>${name}</b></td><td class="${a && a.s !== null ? cls(a.s * 100) : ""}">${a && a.v ? esc(a.v) : "-"}</td><td class="${b && b.s !== null ? cls(b.s * 100) : ""}">${b && b.v ? esc(b.v) : "-"}</td><td class="muted">${why}</td></tr>`;

const CAT_LABEL = { speed: "Speed", content: "Content", tech: "Technical", local: "Local presence", trust: "Trust", compete: "Against the competition" };
const EFFORT_HOURS = { "15 minutes": 0.25, "30 minutes": 0.5, "1 hour": 1, "2 hours": 2, "half a day": 4, "1 day": 8, "1-2 days": 12, "2+ days": 20 };
const hoursOf = f => EFFORT_HOURS[f.effort] ?? 0;
const sumHours = list => Math.round(list.reduce((a, f) => a + hoursOf(f), 0) * 100) / 100;

function verdict(d) {
  const c = d.findings.filter(f => f.sev === "critical").length;
  const h = d.findings.filter(f => f.sev === "high").length;
  const s = d.scores;
  const measured = Object.entries({ speed: s.speed, content: s.content, technical: s.tech, local: s.local, trust: s.trust })
    .filter(([, v]) => v !== null);
  const worst = measured.length ? measured.sort((a, b) => a[1] - b[1])[0] : null;
  const linkNote = d.links.reliable === false ? "" : d.links.brokenInternal ? `, and ${d.links.brokenInternal} internal link${d.links.brokenInternal > 1 ? "s are" : " is"} dead` : "";
  return `<div class="verdict"><b>Where this site actually stands.</b> Overall health ${s.overall}/100 across ${d.crawl.pages.length} crawled pages.
    ${c + h === 0 ? "Nothing critical is broken; the work below is sharpening." :
      `${c} critical and ${h} high-impact issue${c + h === 1 ? "" : "s"} sit between a searcher and the phone ringing.`}
    ${worst ? `The weakest measured area is <b>${worst[0]}</b> at ${worst[1]}/100${linkNote}.` : ""}
    Where a finding has evidence, it is printed under it.</div>`;
}

function nextSteps(d) {
  const c = d.findings.filter(f => f.sev === "critical").length;
  const h = d.findings.filter(f => f.sev === "high").length;
  if (c + h === 0) return "Nothing here needs a rebuild. Work through the list on a normal maintenance schedule and re-run this audit every few months to confirm nothing has slipped.";
  if (c >= 3) return "The number of critical issues points to a rebuild rather than patching one page at a time: line the fixes up together so the site is never half broken while the work is in progress.";
  return "None of this needs a rebuild. Work the quick wins first, then the month-long items, in the order they are ranked above.";
}

function planBuckets(d) {
  const quick = d.findings.filter(f => /15 minutes|30 minutes|1 hour/.test(f.effort));
  const month = d.findings.filter(f => /2 hours|half a day/.test(f.effort));
  const later = d.findings.filter(f => /day/.test(f.effort) && !/half a day/.test(f.effort));
  return { quick, month, later };
}

// Every page crawled, indexable and not, with the reason: the same "Pages" view Search
// Console shows, so a reader can see why a page will or won't show up in results.
function indexabilityBlock(d) {
  const idx = d.crawl.pages.filter(p => p.indexable);
  const notIdx = d.crawl.pages.filter(p => !p.indexable);
  const table = list => `<table class="dense"><tr><th>Page</th><th>Reason</th></tr>${rows(list.map(p => `<tr><td>${esc(p.path)}</td><td class="muted">${esc(p.indexReason || "")}</td></tr>`), 2)}</table>`;
  return `<h3>Not indexable (${notIdx.length})</h3>${table(notIdx)}
    <h3>Indexable (${idx.length})</h3>${table(idx)}`;
}

// Findings grouped by category so the reader can jump straight to the area they care
// about; the raw finding id stays out of the visible text and only lives in the row's
// data attribute, for anyone cross-referencing the JSON.
function findingsBlock(d) {
  const groups = Object.keys(CAT_LABEL).map(cat => ({ label: CAT_LABEL[cat], list: d.findings.filter(f => f.cat === cat) })).filter(g => g.list.length);
  if (!groups.length) return `<p class="muted">Nothing found.</p>`;
  return groups.map(g => `${sec(g.label)}
    <table class="dense"><tr><th>Priority</th><th>Finding</th><th>The fix</th><th>Effort</th></tr>
      ${g.list.map(f => `<tr class="finding" data-id="${esc(f.id)}">
        <td><span class="pill p-${f.sev}">${f.sev}</span></td>
        <td><b>${esc(f.title)}</b><br><span class="muted">${esc(f.cost)}</span>${li(f.evidence)}</td>
        <td>${esc(f.fix)}</td><td class="muted">${esc(f.effort)}</td></tr>`).join("")}
    </table>`).join("");
}

// Homepage-only comparison against the same competitors the crawl scored: one row per
// measure, this site's own column first, the best value in each row marked, then the
// measures this site is behind on with the fix for each. The rows come from compete.mjs.
function headToHeadPage(d, client) {
  const hh = d.headToHead;
  // Runs archived before the comparison existed still render: build it from the cards.
  const cmp = hh.rows ? hh : compare(hh.self, hh.competitors, { siteType: d.siteType });
  const names = ["This site", ...cmp.names];
  const unread = (d.competitors || []).filter(c => !c.ok);
  const bodyRows = cmp.rows.map(r => `<tr><td>${esc(r.label)}</td>${r.text.map((t, i) => `<td class="${r.best[i] ? "g best" : ""}">${esc(t)}</td>`).join("")}</tr>`).join("");
  return `<div class="page">${head(d, undefined, client)}
    ${sec("Head to head: this site vs the competition")}
    <p class="note">Same homepage checks run on every site listed, back to back, so the numbers compare like with like. A few points of Lighthouse difference is noise, so a row only counts as behind when the gap is real.</p>
    ${foundLine(hh.discovery, d.competitors)}
    <table class="dense"><tr><th>Measure</th>${names.map(n => `<th>${esc(n)}</th>`).join("")}</tr>${bodyRows}</table>
    ${unread.length ? `<p class="note">Could not be read: ${unread.map(x => esc(x.url)).join(", ")}.</p>` : ""}
    <div class="verdict"><b>Where this site stands.</b> ${esc(cmp.summary.line)} ${esc(standing(cmp.summary))}</div>
    ${cmp.losses.length ? `${sec("What puts this site on top")}
    <table class="dense"><tr><th>Measure</th><th>This site</th><th>Best of them</th><th>The fix</th><th>Effort</th></tr>
      ${cmp.losses.map(l => `<tr><td><b>${esc(l.label)}</b></td><td class="r">${esc(l.selfText)}</td><td class="g">${esc(l.bestText)} <span class="muted">${esc(l.bestHost)}</span></td><td>${esc(l.fix)}</td><td class="muted">${esc(l.effort)}</td></tr>`).join("")}
    </table>` : ""}
    ${cmp.leads.length ? `<h3>Already ahead</h3><p class="muted">${cmp.leads.map(l => `${esc(l.label)} (${esc(l.selfText)})`).join(" · ")}</p>` : ""}
    ${foot(d, "Head to head")}
  </div>`;
}

// The shared page set. client=false is the owner's working copy (jargon, raw transport
// numbers, run-internals appendices); client=true drops the owner marks and the two
// appendix pages, since those describe how the audit was run rather than the site.
function buildPages(d, client) {
  const lh = d.lighthouse, lhd = d.lighthouseDesktop, s = d.scores, pages = d.crawl.pages;
  const sevCount = k => d.findings.filter(f => f.sev === k).length;
  const { quick, month, later } = planBuckets(d);
  const shot = d.detail && d.detail.screenshots && d.detail.screenshots.final;

  const page1 = `<div class="page">${head(d, `${d.town ? esc(d.town) + " · " : ""}${esc(d.url)}${d.rating ? ` · ${esc(d.rating)}★${d.reviews ? ` (${esc(d.reviews)})` : ""}` : ""}`, client)}
    ${d.runNotes && d.runNotes.length ? `<div class="runnote"><b>What this run could not measure.</b><ul>${d.runNotes.map(n => `<li>${esc(n)}</li>`).join("")}</ul></div>` : ""}
    ${d.history ? `<div class="histnote">Since ${esc(d.history.previous.date)}: ${esc(d.history.diff.summary)}</div>` : ""}
    ${verdict(d)}
    <div class="hero">
      ${shot ? `<div class="heroShot"><img src="${shot}" alt="Mobile screenshot of the homepage"></div>` : ""}
      <div class="heroScore"><b class="${cls(s.overall)}">${s.overall}</b><span>site health</span></div>
      <div class="bars">
        ${bar("Speed", s.speed)}${bar("Content", s.content)}${bar("Technical", s.tech)}${bar("Local", s.local)}${bar("Trust", s.trust)}
      </div>
    </div>
    <div class="stats">
      <div class="stat"><b>${pages.length}</b><span>pages crawled</span></div>
      <div class="stat"><b>${d.crawl.linksChecked}</b><span>links checked</span></div>
      <div class="stat"><b class="${d.links.brokenInternal ? "r" : "g"}">${d.links.brokenInternal + d.links.brokenExternal}${d.links.reliable === false ? "*" : ""}</b><span>dead links${d.links.reliable === false ? "*" : ""}</span></div>
      <div class="stat"><b>${d.content.totals.words.toLocaleString()}</b><span>words of copy</span></div>
      <div class="stat"><b class="r">${sevCount("critical")}</b><span>critical</span></div>
      <div class="stat"><b class="y">${sevCount("high")}</b><span>high</span></div>
      <div class="stat"><b>${d.findings.length}</b><span>total findings</span></div>
    </div>
    ${d.links.reliable === false ? `<p class="note">*Dead link counts are not reliable on this site; see Link health for why.</p>` : ""}
    <h2>${d.fixes.length ? `The ${d.fixes.length} that move money first` : "Nothing urgent enough to rank"}</h2>
    ${d.fixes.length ? `<ol class="fixes">${d.fixes.map(f => `<li><div><b>${esc(f.title)}</b><div class="cost">${esc(f.cost)}</div><div class="fix"><em>Fix (${esc(f.effort)}):</em> ${esc(f.fix)}</div></div></li>`).join("")}</ol>`
      : `<p class="muted">No finding crossed the bar that would put it in the top of the list.</p>`}
    <h2>The plan, by how long it takes</h2>
    <div class="plan">
      <div><h4>Quick wins · under an hour each</h4><ul>${quick.slice(0, 8).map(f => `<li>${esc(f.title)}</li>`).join("") || "<li>none</li>"}</ul></div>
      <div><h4>This month · hours to a day</h4><ul>${month.slice(0, 8).map(f => `<li>${esc(f.title)}</li>`).join("") || "<li>none</li>"}</ul></div>
      <div><h4>Bigger builds · a day or more</h4><ul>${later.slice(0, 8).map(f => `<li>${esc(f.title)}</li>`).join("") || "<li>none</li>"}</ul></div>
    </div>
    ${foot(d, "Overview")}
  </div>`;

  const page2 = `<div class="page">${head(d, undefined, client)}
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
    ${d.lighthousePages && d.lighthousePages.length ? `<h3>Inner pages measured</h3>
    <table class="dense"><tr><th>Page</th><th>Speed</th><th>SEO</th><th>Accessibility</th><th>Main content loaded</th><th>Layout stability</th><th>Responsiveness</th></tr>
      ${d.lighthousePages.map(p => `<tr><td>${esc(p.path)}</td>
        <td class="${p.ok && p.perf !== null ? cls(p.perf) : ""}">${p.ok && p.perf !== null ? p.perf : "-"}</td>
        <td class="${p.ok && p.seo !== null ? cls(p.seo) : ""}">${p.ok && p.seo !== null ? p.seo : "-"}</td>
        <td class="${p.ok && p.a11y !== null ? cls(p.a11y) : ""}">${p.ok && p.a11y !== null ? p.a11y : "-"}</td>
        <td>${p.ok ? esc(p.lcp || "-") : "-"}</td><td>${p.ok ? esc(p.cls || "-") : "-"}</td><td>${p.ok ? esc(p.tbt || "-") : "-"}</td></tr>`).join("")}
    </table>` : ""}
    ${d.detail && d.detail.savings && d.detail.savings.length ? `<h3>Biggest wins by time and size saved (mobile)</h3>
    <table class="dense"><tr><th>Change</th><th>Measure</th><th>Time saved</th><th>Size saved</th></tr>
      ${d.detail.savings.map(sv => `<tr><td>${esc(sv.title)}</td><td class="muted">${esc(sv.metric || "")}</td><td>${sv.ms ? sv.ms + " ms" : "-"}</td><td>${sv.kb ? sv.kb + " KB" : "-"}</td></tr>`).join("")}
    </table>` : ""}
    ${d.detail && d.detail.images && d.detail.images.length ? `<h3>Images costing the most</h3>
    <table class="dense"><tr><th>File</th><th>KB</th><th>Wasted KB</th><th>Reason</th></tr>
      ${d.detail.images.slice(0, 8).map(im => `<tr><td class="muted">${esc((im.url || "").split("/").pop())}</td><td>${im.kb ?? "-"}</td><td class="${im.wastedKb ? "y" : ""}">${im.wastedKb ?? "-"}</td><td class="muted">${esc(im.reason || "")}</td></tr>`).join("")}
    </table>` : ""}
    ${d.detail && d.detail.thirdParties && d.detail.thirdParties.length ? `<h3>Third-party scripts</h3>
    <table class="dense"><tr><th>Provider</th><th>Main-thread time</th><th>Size</th></tr>
      ${d.detail.thirdParties.map(t => `<tr><td>${esc(t.entity)}</td><td>${t.mainThreadMs ?? "-"} ms</td><td>${t.kb ?? "-"} KB</td></tr>`).join("")}
    </table>` : ""}
    ${d.detail && d.detail.renderBlocking && d.detail.renderBlocking.length ? `<p class="note">${d.detail.renderBlocking.length} file${d.detail.renderBlocking.length === 1 ? "" : "s"} block the page from drawing anything until they load.</p>` : ""}
    ${d.detail && d.detail.weight ? `<h3>Page weight</h3>
    <p class="note">${d.detail.weight.totalKb} KB across ${d.detail.weight.requests} request${d.detail.weight.requests === 1 ? "" : "s"}: ${Object.entries(d.detail.weight.byType).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v} KB`).join(", ") || "nothing measurable"}.</p>` : ""}
    ${d.detail && d.detail.lcp ? `<p class="note">Main content element: ${esc(d.detail.lcp.element || "unknown")}${d.detail.lcp.url ? " (" + esc(d.detail.lcp.url) + ")" : ""}. Time breakdown: server response ${d.detail.lcp.phases.ttfb ?? "-"} ms, load delay ${d.detail.lcp.phases.loadDelay ?? "-"} ms, load duration ${d.detail.lcp.phases.loadDuration ?? "-"} ms, render delay ${d.detail.lcp.phases.renderDelay ?? "-"} ms.</p>` : ""}
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
    ${foot(d, "Speed")}
  </div>`;

  const r = d.robots;
  const page3 = `<div class="page">${head(d, undefined, client)}
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
      ${d.tls ? `<tr><td>Certificate expires</td><td class="${d.tls.daysLeft <= 14 ? "r" : d.tls.daysLeft <= 30 ? "y" : "g"}">${esc(d.tls.validTo || "-")}${d.tls.daysLeft != null ? ` (${d.tls.daysLeft} days left)` : ""}</td><td class="muted">A lapsed certificate takes the whole site offline with a browser warning.</td></tr>
      <tr><td>Certificate covers both hosts</td><td>${yn(!!(d.tls.coversWww && d.tls.coversApex), "www and root both covered", "one host is not covered")}</td><td class="muted">The uncovered host would show a security warning.</td></tr>
      <tr><td>Certificate trusted</td><td>${yn(d.tls.authorized, "trusted by browsers", "not trusted, browsers will warn")}</td><td class="muted">${esc(d.tls.issuer || "")}</td></tr>` : ""}
    </table>
    ${indexabilityBlock(d)}
    ${(() => {
      const ix = d.indexability, bits = [];
      if (ix.sitemapDead.length) bits.push(`${ix.sitemapDead.length} sitemap link${ix.sitemapDead.length === 1 ? "" : "s"} lead nowhere`);
      if (ix.sitemapNotIndexable.length) bits.push(`${ix.sitemapNotIndexable.length} sitemap page${ix.sitemapNotIndexable.length === 1 ? "" : "s"} cannot be indexed`);
      if (ix.sitemapOffHost.length) bits.push(`${ix.sitemapOffHost.length} sitemap entr${ix.sitemapOffHost.length === 1 ? "y points" : "ies point"} to a different domain`);
      return d.sitemap.found ? `<p class="note">Sitemap hygiene: ${bits.length ? bits.join(", ") + "." : "clean, nothing wrong found."} robots.txt applies its rules to: ${esc(ix.robotsAppliedTo || "all crawlers")}.</p>` : "";
    })()}
    ${d.links.redirecting.length ? `<h3>Internal links that redirect instead of pointing straight at the page</h3>${li(d.links.redirecting.map(x => `${x.from} to ${x.to}`))}` : ""}
    ${d.content.orphans.length ? `<h3>Orphan pages: in the sitemap, linked from nowhere</h3>${li(d.content.orphans.slice(0, 12))}` : ""}
    ${d.crawl.skippedByRobots.length ? `<h3>Skipped because robots.txt disallows them</h3>${li(d.crawl.skippedByRobots.slice(0, 8).map(x => `${x.url} (rule ${x.rule})`))}` : ""}
    ${r && r.disallow.length ? `<h3>robots.txt rules in force</h3>${li(r.disallow.slice(0, 12).map(x => "Disallow: " + x))}` : ""}
    ${foot(d, "Technical health")}
  </div>`;

  const c = d.content;
  const grades = d.quality.readability.map(x => x.grade).filter(g => g != null);
  const avgGrade = grades.length ? Math.round(grades.reduce((a, b) => a + b, 0) / grades.length * 10) / 10 : null;
  const page4 = `<div class="page">${head(d, undefined, client)}
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
    ${sec("Content quality")}
    <table class="dense"><tr><th>Signal</th><th>Result</th></tr>
      <tr><td>Reading level (average grade)</td><td class="${avgGrade === null ? "" : avgGrade > 12 ? "y" : "g"}">${avgGrade === null ? "not measured" : `grade ${avgGrade}`}${d.quality.hardToRead ? `, ${d.quality.hardToRead} page${d.quality.hardToRead === 1 ? "" : "s"} hard to read` : ""}</td></tr>
      <tr><td>Link text quality</td><td class="${(d.quality.anchors.empty + d.quality.anchors.generic) ? "y" : "g"}">${d.quality.anchors.empty} empty, ${d.quality.anchors.generic} vague (like "click here"), out of ${d.quality.anchors.total} links</td></tr>
      <tr><td>Repeated boilerplate across pages</td><td class="${d.quality.boilerplate > 0.5 ? "y" : "g"}">${Math.round(d.quality.boilerplate * 100)}%</td></tr>
      <tr><td>Homepage call to action</td><td class="${d.quality.homeCta.found ? "g" : "r"}">${d.quality.homeCta.found ? `${esc(d.quality.homeCta.kind)}, says "${esc(d.quality.homeCta.text)}"` : "none found"}</td></tr>
    </table>
    ${d.quality.nearDuplicates.length ? `<h3>Pages that read almost the same</h3>
    <table class="dense"><tr><th>Page</th><th>Page</th><th>How similar</th></tr>
      ${d.quality.nearDuplicates.slice(0, 10).map(p => `<tr><td>${esc(p.a)}</td><td>${esc(p.b)}</td><td class="${p.similarity > 0.85 ? "r" : "y"}">${Math.round(p.similarity * 100)}%</td></tr>`).join("")}
    </table>` : ""}
    ${d.quality.placeholders.length ? `<h3>Placeholder text left on the live site</h3>
    <table class="dense"><tr><th>Page</th><th>Found</th></tr>
      ${d.quality.placeholders.map(p => `<tr><td>${esc(p.path)}</td><td class="r">${p.found.map(esc).join(", ")}</td></tr>`).join("")}
    </table>` : ""}
    ${d.quality.titleMismatch.length ? `<h3>Title tag and heading don't match</h3>${li(d.quality.titleMismatch)}` : ""}
    ${d.discovery && !d.competitors.length ? `<p class="note">A search for competitors${d.discovery.queries.length ? ` ("${esc(d.discovery.queries[0])}")` : ""} found none to compare against. ${esc(d.discovery.note || "")}</p>` : ""}
    ${d.competitors.length ? `${sec("Competitors")}
    <table class="dense"><tr><th>Site</th><th>Words on the page</th><th>Schema</th><th>Words they lead with that this site never says</th></tr>
      ${rows(d.competitors.map(x => x.ok
        ? `<tr><td>${esc(x.url)}</td><td>${x.words}</td><td>${esc((x.schema || []).slice(0, 3).join(", ") || "none")}</td><td>${esc((x.gap || []).slice(0, 10).join(", ") || "no gap found")}</td></tr>`
        : `<tr><td>${esc(x.url)}</td><td colspan="3" class="r">could not be read</td></tr>`), 4)}
    </table>` : ""}
    ${d.siteType === "local" ? `${sec("Local presence")}
    <table class="dense"><tr><th>Signal</th><th>Status</th></tr>
      <tr><td>Phone numbers found on the site</td><td>${d.local.phones.map(esc).join(", ") || "none"}</td></tr>
      ${d.gphone ? `<tr><td>Number Google shows</td><td class="${d.local.napMismatch ? "r" : "g"}">${esc(d.gphone)}${d.local.napMismatch ? ", DIFFERENT from the site" : ", matches"}</td></tr>` : ""}
      <tr><td>Tap-to-call coverage</td><td class="${d.local.telPages >= c.totals.pages / 2 ? "g" : "r"}">${d.local.telPages}/${c.totals.pages} pages</td></tr>
      <tr><td>Street address in the copy</td><td>${yn(d.local.hasAddress, "present", "not found")}</td></tr>
      <tr><td>Opening hours</td><td>${yn(d.local.hasHours, "published", "not found")}</td></tr>
      <tr><td>Map embed</td><td>${yn(d.local.hasMap, "present", "none")}</td></tr>
      <tr><td>Contact form</td><td>${yn(d.local.hasForm, "present", "none found")}</td></tr>
      <tr><td>Business schema</td><td class="${d.site.hasLocalSchema ? "g" : "r"}">${d.site.hasLocalSchema ? esc(d.local.schemaTypes.join(", ")) : "none, so Google is guessing"}</td></tr>
      <tr><td>Business schema completeness</td><td class="${d.schema.localBusiness ? (d.schema.localBusiness.missing && d.schema.localBusiness.missing.length ? "y" : "g") : "r"}">${d.schema.localBusiness ? `${Math.round(d.schema.localBusiness.completeness)}%${d.schema.localBusiness.missing && d.schema.localBusiness.missing.length ? `, missing ${d.schema.localBusiness.missing.join(", ")}` : ""}` : "no business schema to check"}</td></tr>
      <tr><td>Reviews marked up in schema</td><td class="${d.schema.selfServing ? "y" : "g"}">${d.schema.selfServing ? "self-published on the site, so Google treats them as unverified" : d.schema.pagesWithLocalSchema ? "not self-published" : "none found"}</td></tr>
      <tr><td>Business profiles found</td><td>${Object.entries(d.profiles).filter(([, v]) => v.length).map(([k]) => esc(k[0].toUpperCase() + k.slice(1))).join(", ") || "none found"}</td></tr>
      <tr><td>License number mentioned</td><td>${yn(!!d.site.licenseMention || pages.some(p => p.licenseMention), "yes", "not found")}</td></tr>
      <tr><td>Booking or scheduling signals</td><td>${(() => { const b = new Set([...(d.site.bookingSignals || []), ...pages.flatMap(p => p.bookingSignals || [])]); return b.size ? esc([...b].join(", ")) : "none found"; })()}</td></tr>
      <tr><td>Forms missing field labels</td><td class="${d.quality.formsWeak.length ? "y" : "g"}">${d.quality.formsWeak.length ? d.quality.formsWeak.map(esc).join(", ") : "none"}</td></tr>
      <tr><td>Analytics</td><td>${yn(!!d.site.analytics, "installed", "nothing measuring visits")}</td></tr>
    </table>` : `<p class="note">Local presence is not scored or shown for this kind of site.</p>`}
    ${foot(d, "Content")}
  </div>`;

  const pageHH = d.headToHead ? headToHeadPage(d, client) : "";

  const broken = d.links.broken;
  const page5 = `<div class="page">${head(d, undefined, client)}
    ${sec("Link health")}
    ${d.links.reliable === false ? `<p class="warn">This site answers HTTP ${d.tech.notFoundStatus} for pages that do not exist, so this audit could not always tell a dead link from a working one. Treat the counts below as a floor, not a final number.</p>` : ""}
    <p class="note">${d.crawl.internalLinksFound} internal and ${d.crawl.externalLinksFound} external link targets were found; ${d.crawl.linksChecked} were requested individually. A status of 0 means the host never answered (DNS, TLS or timeout), which reads to a visitor exactly like a dead link.</p>
    <h3>Broken internal links</h3>
    <table class="dense"><tr><th>Status</th><th>Target</th><th>Linked from</th></tr>
      ${rows(broken.filter(l => l.kind === "internal").slice(0, 40).map(l => `<tr><td class="r">${l.status || "no answer"}</td><td>${esc(l.url)}</td><td class="muted">${esc(l.from)}</td></tr>`), 3)}
    </table>
    <h3>Broken outbound links</h3>
    <table class="dense"><tr><th>Status</th><th>Target</th><th>Linked from</th></tr>
      ${rows(broken.filter(l => l.kind === "external").slice(0, 25).map(l => `<tr><td class="r">${l.status || "no answer"}</td><td>${esc(l.url)}</td><td class="muted">${esc(l.from)}</td></tr>`), 3)}
    </table>
    ${(d.links.brokenImages || []).length ? `<h3>Broken images</h3>
    <table class="dense"><tr><th>Status</th><th>Target</th><th>Linked from</th></tr>
      ${d.links.brokenImages.slice(0, 20).map(l => `<tr><td class="r">${l.status || "no answer"}</td><td>${esc(l.url)}</td><td class="muted">${esc(l.from)}</td></tr>`).join("")}
    </table>` : ""}
    ${(d.links.blocked || []).length ? `<h3>Refused the crawler: check these by hand, usually fine</h3>
    <p class="note">401, 403 and 429 normally mean the far end blocks bots rather than that the link is dead. These are excluded from the broken counts above.</p>
    <table class="dense"><tr><th>Status</th><th>Target</th><th>Linked from</th></tr>
      ${d.links.blocked.slice(0, 20).map(l => `<tr><td class="y">${l.status}</td><td>${esc(l.url)}</td><td class="muted">${esc(l.from)}</td></tr>`).join("")}
    </table>` : ""}
    ${foot(d, "Link health")}
  </div>`;

  const page6 = `<div class="page">${head(d, undefined, client)}
    ${sec("Every finding, ranked")}
    ${findingsBlock(d)}
    <h2>What happens next</h2>
    <p>${esc(nextSteps(d))}</p>
    ${foot(d, "Findings")}
  </div>`;

  const page7 = `<div class="page">${head(d, undefined, client)}
    ${sec("Appendix: every page crawled")}
    <table class="dense"><tr><th>Path</th><th>Status</th><th>TTFB</th><th>Words</th><th>Title</th><th>Meta</th><th>H1</th><th>Img alt</th><th>Links out</th><th>Depth</th><th>Index</th></tr>
      ${rows(pages.map(p => `<tr>
        <td>${esc((p.path || p.url).slice(0, 46))}</td>
        <td class="${p.status >= 400 || !p.status ? "r" : "g"}">${p.status || "-"}</td>
        <td class="${p.ttfbMs > 800 ? "r" : ""}">${p.ttfbMs ?? "-"}</td>
        <td class="${p.wordCount < 300 ? "r" : ""}">${p.wordCount ?? "-"}</td>
        <td class="${!p.title ? "r" : p.titleLen < 25 || p.titleLen > 65 ? "y" : "g"}">${p.title ? p.titleLen : "none"}</td>
        <td class="${!p.metaDesc ? "r" : p.metaLen < 70 || p.metaLen > 165 ? "y" : "g"}">${p.metaDesc ? p.metaLen : "none"}</td>
        <td class="${(p.h1s || []).length === 1 ? "g" : "r"}">${(p.h1s || []).length}</td>
        <td>${p.imgCount ? Math.round((p.imgsWithAlt / p.imgCount) * 100) + "%" : "-"}</td>
        <td class="muted">${p.internalOut ?? "-"}/${p.externalOut ?? "-"}</td>
        <td>${p.depth ?? "-"}</td>
        <td class="${p.indexable ? "g" : "y"}">${p.indexable ? "yes" : "no"}</td></tr>`), 11)}
    </table>
    <p class="note">Title and Meta columns show character counts: red means missing, amber means outside the range Google displays cleanly (25-65 and 70-165). Links out is internal/external.</p>
    ${foot(d, "Appendix: pages")}
  </div>`;

  const page8 = `<div class="page">${head(d, undefined, client)}
    ${sec("Appendix: Lighthouse audits that failed (mobile)")}
    <table class="dense"><tr><th>Audit</th><th>Detail</th></tr>
      ${rows((lh.failures || []).slice(0, 60).map(f => `<tr><td>${esc(f.title)}</td><td class="muted">${esc(f.display || "")}</td></tr>`), 2)}
    </table>
    ${sec("How this audit was run")}
    <p class="note">Crawl: sitemap-seeded breadth-first from ${esc(d.url)}, ${d.crawl.pagesCrawled} URLs fetched of ${d.crawl.discovered} discovered, capped at ${d.maxPages} pages, 120ms between requests per worker, robots.txt disallow rules honoured.
    ${d.crawl.rendered ? `${d.crawl.rendered} page${d.crawl.rendered === 1 ? "" : "s"} needed a browser render before there was anything to read.` : "No page needed a browser render; plain HTML had everything."}
    Speed: Google Lighthouse via headless Edge, mobile emulation and the desktop preset, run back to back on the homepage${d.lighthousePages && d.lighthousePages.length ? ` and on ${d.lighthousePages.length} inner page${d.lighthousePages.length === 1 ? "" : "s"}` : ""}.
    Transport facts (TTFB, HTTP version, compression, headers) come from a direct curl probe, not from the browser.
    Links: every internal target not already crawled, plus up to 60 outbound targets, requested individually; ${d.links.imagesChecked} image${d.links.imagesChecked === 1 ? "" : "s"} checked for a broken source.
    Nothing here is estimated. Every number above came from a request made on ${d.date}.</p>
    ${foot(d, "Appendix: run detail")}
  </div>`;

  return [page1, page2, page3, page4, pageHH, page5, page6, ...(client ? [] : [page7, page8])].filter(Boolean);
}

export function buildProReport(d) {
  const html = buildPages(d, false).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.name)} · full technical audit</title><style>${PRO_CSS}</style></head><body>${html}</body></html>`;
}

// Same evidence as the owner copy, without the run-internals appendices, the owner
// badge, or anything that only makes sense to someone reading the raw audit JSON.
export function buildClientReport(d) {
  const html = buildPages(d, true).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.name)} · site audit</title><style>${PRO_CSS}</style></head><body>${html}</body></html>`;
}

// One page for the clipboard: what to do, in order, with the effort next to it.
export function buildProChecklist(d) {
  const { quick, month, later } = planBuckets(d);
  const block = (title, list) => `<h3>${title}</h3><table class="dense"><tr><th>#</th><th>Do this</th><th>Effort</th><th>Why</th></tr>
    ${list.length ? list.map((f, i) => `<tr><td>${i + 1}</td><td><b>${esc(f.title)}</b><br>${esc(f.fix)}</td><td>${esc(f.effort)}</td><td class="muted">${esc(f.cost)}</td></tr>`).join("")
      : `<tr><td colspan="4" class="muted">nothing in this bucket</td></tr>`}</table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.name)} · work checklist</title><style>${PRO_CSS}</style></head><body>
  <div class="page">${head(d, `${esc(d.url)} · health ${d.scores.overall}/100 · ${d.findings.length} findings`, false)}
    ${block("Quick wins, under an hour each", quick)}
    ${block("This month: hours to a day", month)}
    ${block("Bigger builds: a day or more", later)}
    <div class="plan">
      <div><h4>Scope</h4><ul>
        <li>Quick wins: ${quick.length} finding${quick.length === 1 ? "" : "s"}, about ${sumHours(quick)}h</li>
        <li>This month: ${month.length} finding${month.length === 1 ? "" : "s"}, about ${sumHours(month)}h</li>
        <li>Bigger builds: ${later.length} finding${later.length === 1 ? "" : "s"}, about ${sumHours(later)}h</li>
        <li>Total: ${d.findings.length} finding${d.findings.length === 1 ? "" : "s"}, about ${sumHours(d.findings)}h</li>
      </ul></div>
    </div>
    ${foot(d, "Checklist")}
  </div></body></html>`;
}
