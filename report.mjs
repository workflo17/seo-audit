// Client-facing documents: the full multi-page report and the 1-page leave-behind.
// Both print to letter-size PDF via headless Edge and read clean on screen.
import { BRAND } from "./lib.mjs";
import { standing, host } from "./compete.mjs";

// How the competitors got onto the page: which ones a search found, with the query, and
// what the search could not do. Empty when every competitor was named by hand.
function foundLine(discovery, comps) {
  if (!discovery) return "";
  const found = comps.filter(x => x.ok && x.found).map(x => host(x.url));
  const bits = [];
  if (found.length) bits.push(`${found.join(", ")} ${found.length === 1 ? "was" : "were"} found by searching for "${discovery.queries[0]}".`);
  if (discovery.note) bits.push(discovery.note);
  return bits.length ? `<p class="muted">${esc(bits.join(" "))}</p>` : "";
}

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
// Exported so the owner-only pro report (report-pro.mjs) inherits the same visual system.
export const CSS = `
  @page{size:letter; margin:0}
  *{box-sizing:border-box} html,body{margin:0}
  body{font:13px/1.5 'Segoe UI',system-ui,sans-serif; color:#1B1F23; background:#fff}
  .page{width:8.5in; min-height:11in; padding:.55in .6in; margin:0 auto; display:flex; flex-direction:column; page-break-after:always; position:relative}
  .page:last-child{page-break-after:auto}
  @media screen{ body{background:#E9EBED; padding:24px 0} .page{box-shadow:0 2px 14px rgba(0,0,0,.12); margin-bottom:24px; background:#fff} }
  .disp{font-family:Bahnschrift,'Arial Narrow',sans-serif}
  header{display:flex; justify-content:space-between; align-items:baseline; border-bottom:3px solid #E8590C; padding-bottom:10px}
  .brand{font:700 15px Bahnschrift,sans-serif; text-transform:uppercase; letter-spacing:1.5px}
  .brand small{display:block; font:400 10.5px 'Segoe UI'; color:#5A6470; letter-spacing:0; text-transform:none}
  .date{font:11px Consolas,monospace; color:#5A6470}
  h1{font:700 26px Bahnschrift,sans-serif; margin:14px 0 2px; text-transform:uppercase; letter-spacing:.5px}
  .sub{color:#5A6470; font-size:12.5px}
  h2{font:700 14px Bahnschrift,sans-serif; text-transform:uppercase; letter-spacing:1.5px; margin:18px 0 8px; color:#E8590C}
  h3{font:700 12.5px 'Segoe UI'; margin:12px 0 4px}
  p{margin:4px 0}
  .muted{color:#5A6470}
  .row{display:flex; gap:10px; margin:14px 0}
  .sc{flex:1; border:1px solid #DDE1E6; border-radius:8px; text-align:center; padding:8px 4px}
  .sc b{display:block; font:700 26px Bahnschrift,sans-serif}
  .sc span{font-size:9.5px; text-transform:uppercase; letter-spacing:1px; color:#5A6470}
  .g{color:#2F9E44}.y{color:#B4690E}.r{color:#C92A2A}.b{color:#1971C2}
  .facts{display:flex; flex-wrap:wrap; gap:6px; margin:6px 0}
  .fact{font-size:11px; border:1px solid #DDE1E6; border-radius:12px; padding:2px 10px; color:#3D4650}
  .fact.bad{border-color:#C92A2A; color:#C92A2A}
  table{width:100%; border-collapse:collapse; font-size:11.5px; margin:6px 0}
  th{text-align:left; font:700 10px Bahnschrift,sans-serif; text-transform:uppercase; letter-spacing:1px; color:#5A6470; border-bottom:2px solid #DDE1E6; padding:4px 8px 4px 0}
  td{border-bottom:1px solid #EEF0F2; padding:5px 8px 5px 0; vertical-align:top}
  table.tight{font-size:11px} table.tight th,table.tight td{padding:3px 8px 3px 0}
  .pill{display:inline-block; font:700 9.5px Bahnschrift,sans-serif; text-transform:uppercase; letter-spacing:.8px; border-radius:10px; padding:1px 8px}
  .p-critical{background:#FBEAEA; color:#C92A2A}
  .p-high{background:#FDEEE3; color:#B4690E}
  .p-medium{background:#E7F0FA; color:#1971C2}
  .p-low{background:#EEF0F2; color:#5A6470}
  ol.fixes{margin:0; padding:0; list-style:none; counter-reset:fx}
  ol.fixes li{counter-increment:fx; display:flex; gap:12px; padding:9px 0; border-bottom:1px solid #EEF0F2}
  ol.fixes li::before{content:counter(fx); font:700 17px Bahnschrift,sans-serif; color:#E8590C; min-width:20px}
  ol.fixes b{display:block; font-size:13.5px}
  ol.fixes .cost{color:#5A6470; font-size:11.5px; margin:1px 0}
  ol.fixes .fix{font-size:11.5px}
  ol.fixes .fix em{font-style:normal; font-weight:700; color:#1971C2}
  .verdict{border-left:4px solid #E8590C; background:#FDF3EC; border-radius:0 8px 8px 0; padding:10px 14px; margin:12px 0; font-size:13px}
  footer{margin-top:auto; border-top:3px solid #1B1F23; padding-top:9px; display:flex; justify-content:space-between; align-items:center; font-size:11px; color:#5A6470}
  footer b{color:#1B1F23; font-size:12.5px}
  .pageno{position:absolute; bottom:.3in; right:.6in; font:10px Consolas,monospace; color:#98A2AD}
  .paywall{border:1px solid #DDE1E6; border-radius:8px; padding:14px 16px; margin:14px 0; background:#FDF3EC}
  .paywallBadge{display:inline-block; font:700 10px Bahnschrift,sans-serif; text-transform:uppercase; letter-spacing:1px; background:#EEF0F2; color:#5A6470; border-radius:10px; padding:3px 10px; margin-bottom:8px}
  .paywallCopy{color:#5A6470; font-size:12.5px; margin:0 0 10px}
  .unlockBtn{background:#E8590C; color:#fff; border:0; border-radius:9px; padding:11px 22px; font:700 13.5px Bahnschrift,sans-serif; text-transform:uppercase; letter-spacing:1px; cursor:pointer}
  .unlockBtn[disabled]{opacity:.5; cursor:default}
  .paywallErr{font-size:12px; color:#C92A2A; margin:10px 0 0}
  .paywallOk{color:#1971C2}
  @media print{ tr, li, .fixes li { break-inside: avoid } }
`;
const head = (data, sub) => `<header><div class="brand">${esc(BRAND.name)}<small>${esc(BRAND.tagline)}</small></div><span class="date">${data.date}</span></header>
  ${sub ? `<h1>${esc(data.name)}</h1><div class="sub">${sub}</div>` : ""}`;
const foot = (data, n, of) => `<footer><div><b>${esc(BRAND.contact)}</b> · every fix in this report is included in the first month of work</div><div>prepared for ${esc(data.name)}</div></footer><span class="pageno">${n} / ${of}</span>`;
const scoreCell = (lh, label, v) => `<div class="sc"><b class="${v >= 90 ? "g" : v >= 50 ? "y" : "r"}">${lh.ok ? v : "n/a"}</b><span>${label}</span></div>`;

function subline(data) {
  return `${data.town ? esc(data.town) + " · " : ""}${esc(data.url)}${data.rating ? ` · ${esc(data.rating)}★ on Google${data.reviews ? ` (${esc(data.reviews)} reviews)` : ""}` : ""}`;
}
function factChips(data) {
  const s = data.site, lh = data.lighthouse;
  const chip = (ok, good, bad) => `<span class="fact ${ok ? "" : "bad"}">${ok ? good : bad}</span>`;
  return `<div class="facts">
    ${lh.ok && lh.lcp.v ? `<span class="fact">page appears in ${lh.lcp.v}</span>` : ""}
    ${chip(s.https, "HTTPS ok", "no HTTPS")}
    ${chip(s.hasLocalSchema, "schema present", "no business schema")}
    ${chip(s.tels.length > 0, "tap-to-call ok", "no tap-to-call")}
    ${chip(!data.napMismatch, "phone consistent", "phone differs from Google")}
    ${chip(s.hasSitemap, "sitemap ok", "no sitemap")}
    ${chip(s.analytics, "analytics installed", "no analytics")}
    ${chip(!s.copyrightYear || s.copyrightYear >= new Date().getFullYear() - 1, "footer current", "footer says © " + s.copyrightYear)}
  </div>`;
}
function verdict(data) {
  const c = data.findings.filter(f => f.sev === "critical").length;
  const h = data.findings.filter(f => f.sev === "high").length;
  const asset = data.rating ? `The reputation is real (${esc(data.rating)}★${data.reviews ? ` across ${esc(data.reviews)} reviews` : ""}), but the website isn't carrying it.`
              : "The business is stronger than its website.";
  const load = c + h === 0 ? "The site is fundamentally healthy; the work below is sharpening, not rescue."
    : `We found ${c} critical and ${h} high-impact issue${c + h === 1 ? "" : "s"} standing between searchers and the phone ringing.`;
  return `<div class="verdict"><b>The short version.</b> ${asset} ${load} Every item in this report has a concrete fix, starting with the list below.</div>`;
}
const fixList = fixes => `<ol class="fixes">${fixes.map(f => `<li><div><b>${esc(f.title)}</b><div class="cost">${esc(f.cost)}</div><div class="fix"><em>Fix${f.effort ? ` (${esc(f.effort)})` : ""}:</em> ${esc(f.fix)}</div></div></li>`).join("")}</ol>`;

// ---------- the 1-page leave-behind ----------
export function buildLeavebehind(data) {
  const lh = data.lighthouse;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(data.name)} · site audit</title><style>${CSS}</style></head><body>
  <div class="page">${head(data, subline(data))}
    <div class="row">${scoreCell(lh, "Speed", lh.perf)}${scoreCell(lh, "SEO", lh.seo)}${scoreCell(lh, "Accessibility", lh.a11y)}${scoreCell(lh, "Best practices", lh.bp)}
      <div class="sc"><b class="${data.site.viewport ? "g" : "r"}">${data.site.viewport ? "yes" : "NO"}</b><span>Mobile layout</span></div></div>
    ${factChips(data)}
    ${data.competition ? `<div class="verdict">${esc(data.competition.summary.line)}${data.competition.losses.length ? ` The gaps, biggest first: ${data.competition.losses.slice(0, 4).map(l => esc(`${l.label.toLowerCase()} (${l.selfText} here, ${l.bestText} at ${l.bestHost})`)).join("; ")}.` : ""}</div>` : ""}
    <h2>The ${data.fixes.length} fixes, in order of impact</h2>
    ${fixList(data.fixes)}
    ${foot(data, 1, 1)}
  </div></body></html>`;
}

// ---------- head to head ----------
// The same homepage checks, run on this site and each competitor back to back. Green marks
// the best in a row; the table under it is what closes each gap. Up to three gaps share the
// comparison's page; more than that and the gaps get a page of their own, so nothing spills
// past the sheet when three competitors lead on a dozen measures.
const headToHeadPageCount = data => !data.competition ? 0 : data.competition.losses.length > 3 ? 2 : 1;
function headToHeadPages(data, firstNo, PAGES) {
  const c = data.competition;
  const names = ["This site", ...c.names];
  const unread = c.competitors.filter(x => !x.ok);
  const gapWords = [...new Set(c.competitors.flatMap(x => x.gap || []))].slice(0, 10);
  const body = c.rows.map(r => `<tr><td>${esc(r.label)}</td>${r.text.map((t, i) => `<td class="${r.best[i] ? "g" : ""}">${r.best[i] ? `<b>${esc(t)}</b>` : esc(t)}</td>`).join("")}</tr>`).join("");
  const gaps = `${c.losses.length ? `<h2>What puts this site on top</h2>
    <table class="tight"><tr><th>Measure</th><th>The gap</th><th>The fix</th><th>Effort</th></tr>
      ${c.losses.map(l => `<tr><td><b>${esc(l.label)}</b></td><td><span class="r">${esc(l.selfText)}</span> here, <span class="g">${esc(l.bestText)}</span> at ${esc(l.bestHost)}</td><td>${esc(l.fix)}</td><td class="muted">${esc(l.effort)}</td></tr>`).join("")}
    </table>` : ""}
    ${gapWords.length ? `<p class="muted"><b>Words they lead with that this site never says:</b> ${gapWords.map(esc).join(", ")}.</p>` : ""}`;
  const split = headToHeadPageCount(data) === 2;
  const first = `<div class="page">${head(data)}
    <h2>Head to head: this site vs ${esc(c.names.join(", ") || "the competition")}</h2>
    <p class="muted">The same homepage checks, run on every site here back to back. Green marks the best in each row; a few points of Lighthouse difference counts as level.</p>
    ${foundLine(c.discovery, c.competitors)}
    <table class="tight"><tr><th>Measure</th>${names.map(n => `<th>${esc(n)}</th>`).join("")}</tr>${body}</table>
    ${unread.length ? `<p class="muted">Could not be read: ${unread.map(x => esc(x.url)).join(", ")}.</p>` : ""}
    <div class="verdict"><b>Where this site stands.</b> ${esc(c.summary.line)} ${esc(standing(c.summary))}</div>
    ${split ? "" : gaps}
    ${foot(data, firstNo, PAGES)}
  </div>`;
  if (!split) return [first];
  return [first, `<div class="page">${head(data)}
    ${gaps}
    ${foot(data, firstNo + 1, PAGES)}
  </div>`];
}

// ---------- the full report ----------
export function buildReport(data) {
  const lh = data.lighthouse, s = data.site, PAGES = 4 + headToHeadPageCount(data);
  const m = (met, name, why) => lh.ok && met.v ? `<tr><td><b>${name}</b></td><td>${esc(met.v)}</td><td class="${met.s >= 0.9 ? "g" : met.s >= 0.5 ? "y" : "r"}">${met.s >= 0.9 ? "good" : met.s >= 0.5 ? "needs work" : "poor"}</td><td class="muted">${why}</td></tr>` : "";

  const page1 = `<div class="page">${head(data, subline(data))}
    ${verdict(data)}
    <div class="row">${scoreCell(lh, "Speed", lh.perf)}${scoreCell(lh, "SEO", lh.seo)}${scoreCell(lh, "Accessibility", lh.a11y)}${scoreCell(lh, "Best practices", lh.bp)}
      <div class="sc"><b class="${s.viewport ? "g" : "r"}">${s.viewport ? "yes" : "NO"}</b><span>Mobile layout</span></div></div>
    ${factChips(data)}
    <h2>The ${data.fixes.length} fixes that matter most</h2>
    ${fixList(data.fixes)}
    ${foot(data, 1, PAGES)}
  </div>`;

  const page2 = `<div class="page">${head(data)}
    <h2>Speed &amp; what a visitor feels</h2>
    <p class="muted">Measured with Google's Lighthouse on a simulated phone connection: the same lens Google uses for ranking.</p>
    <table><tr><th>Measure</th><th>Result</th><th>Rating</th><th>What it means for a customer</th></tr>
      ${m(lh.fcp || {}, "First content appears", "How long the screen stays blank.")}
      ${m(lh.lcp || {}, "Main content loaded", "When the page feels 'there'. Google's line is 2.5 seconds.")}
      ${m(lh.tbt || {}, "Page responsiveness", "How long taps get ignored while scripts run.")}
      ${m(lh.cls || {}, "Layout stability", "Whether buttons jump around as things load.")}
      ${m(lh.si || {}, "Speed index", "Overall how quickly the page looks complete.")}
    </table>
    ${lh.ok && lh.opportunities.length ? `<h3>The biggest wins, by time saved</h3>
    <table><tr><th>Change</th><th>Estimated saving</th></tr>
      ${lh.opportunities.map(o => `<tr><td>${esc(o.title)}</td><td>${esc(o.save)}</td></tr>`).join("")}</table>` : ""}
    <h2>Mobile experience</h2>
    <div class="facts">
      <span class="fact ${s.viewport ? "" : "bad"}">${s.viewport ? "mobile layout present" : "NO mobile layout"}</span>
      <span class="fact ${s.tels.length ? "" : "bad"}">${s.tels.length ? "numbers are tappable" : "numbers are not tappable"}</span>
      ${lh.ok ? `<span class="fact ${lh.tapTargets ? "bad" : ""}">${lh.tapTargets ? "tap targets too small" : "tap targets ok"}</span>
      <span class="fact ${lh.fontSize ? "bad" : ""}">${lh.fontSize ? "text too small on phones" : "text size ok"}</span>` : ""}
    </div>
    <p class="muted">Most first visits from local search happen on a phone. Anything flagged red above is happening to real customers today.</p>
    ${foot(data, 2, PAGES)}
  </div>`;

  const pagesRows = [
    `<tr><td>/ (home)</td><td>${esc(s.title || "none")}${s.title ? ` <span class="muted">(${s.title.length} ch)</span>` : ""}</td><td>${s.metaDesc ? "yes" : '<span class="r">missing</span>'}</td><td>${s.h1s.length}</td></tr>`,
    ...data.crawl.pages.map(p => p.ok
      ? `<tr><td>${esc(p.path)}</td><td>${esc(p.title || "none")}${p.title ? ` <span class="muted">(${p.title.length} ch)</span>` : ""}</td><td>${p.metaDesc ? "yes" : '<span class="r">missing</span>'}</td><td>${p.h1Count}</td></tr>`
      : `<tr><td>${esc(p.url)}</td><td colspan="3" class="r">did not load</td></tr>`)
  ].join("");
  const page3 = `<div class="page">${head(data)}
    <h2>How the site reads to Google</h2>
    <table><tr><th>Page</th><th>Title</th><th>Description</th><th>H1s</th></tr>${pagesRows}</table>
    <p class="muted">${data.crawl.totalInternal} internal links found · ${data.crawl.linkSample.broken > 0 ? `${data.crawl.linkSample.broken} of ${data.crawl.linkSample.checked} sampled links were dead.` : `no dead links in the ${data.crawl.linkSample.checked} sampled.`}</p>
    <h2>Local presence</h2>
    <table><tr><th>Signal</th><th>Status</th></tr>
      <tr><td>Phone on the site</td><td>${[...new Set([...s.phones])].map(p => p.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")).join(", ") || "none found"}</td></tr>
      ${data.gphone ? `<tr><td>Phone Google shows</td><td class="${data.napMismatch ? "r" : "g"}">${esc(data.gphone)}${data.napMismatch ? ", different from the site" : ", matches"}</td></tr>` : ""}
      <tr><td>Business schema (what Google can read)</td><td class="${s.hasLocalSchema ? "g" : "r"}">${s.hasLocalSchema ? "present: " + esc([...new Set(s.ldTypes)].join(", ")) : "none, Google is guessing"}</td></tr>
      <tr><td>Sitemap / robots.txt</td><td class="${s.hasSitemap ? "g" : "r"}">${s.hasSitemap ? "present" : "missing"} / ${s.hasRobots ? "present" : "missing"}</td></tr>
      ${data.rating ? `<tr><td>Google rating</td><td>${esc(data.rating)}★${data.reviews ? ` · ${esc(data.reviews)} reviews` : ""}</td></tr>` : ""}
    </table>
    ${data.discovery && !data.competition ? `<p class="muted">A search for competitors${data.discovery.queries.length ? ` ("${esc(data.discovery.queries[0])}")` : ""} found none to compare against. ${esc(data.discovery.note || "")}</p>` : ""}
    <h2>Trust signals</h2>
    <div class="facts">
      <span class="fact ${s.https ? "" : "bad"}">${s.https ? "HTTPS" : "no HTTPS"}</span>
      <span class="fact ${!s.copyrightYear || s.copyrightYear >= new Date().getFullYear() - 1 ? "" : "bad"}">footer © ${s.copyrightYear ?? "n/a"}</span>
      <span class="fact ${s.favicon ? "" : "bad"}">${s.favicon ? "favicon ok" : "no favicon"}</span>
      <span class="fact ${s.ogTitle ? "" : "bad"}">${s.ogTitle ? "social preview ok" : "no social preview"}</span>
      <span class="fact ${s.analytics ? "" : "bad"}">${s.analytics ? "analytics installed" : "no analytics"}</span>
      <span class="fact">${s.altPct}% of images described</span>
    </div>
    ${foot(data, 3, PAGES)}
  </div>`;

  const page4 = `<div class="page">${head(data)}
    <h2>The full work list, prioritized</h2>
    <table class="tight"><tr><th>Priority</th><th>Finding</th><th>The fix</th></tr>
      ${data.findings.map(f => `<tr><td><span class="pill p-${f.sev}">${f.sev}</span></td><td><b>${esc(f.title)}</b><br><span class="muted">${esc(f.cost)}</span></td><td>${esc(f.fix)}</td></tr>`).join("")}
    </table>
    <h2>What happens next</h2>
    <p>${data.findings.some(f => f.sev === "critical" || f.sev === "high")
      ? "Month one covers the rebuild: mobile-first, your real photos and reviews, the phone number made consistent everywhere, and a machine-readable version of the business for Google. You approve everything before it goes live."
      : "The site is in good shape, so this becomes a light monthly maintenance plan: watch the numbers, fix anything that slips, and keep the business details current with Google as they change."}</p>
    ${foot(data, PAGES, PAGES)}
  </div>`;

  const pageHH = data.competition ? headToHeadPages(data, 4, PAGES).join("") : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(data.name)} · full site audit</title><style>${CSS}</style></head><body>${page1}${page2}${page3}${pageHH}${page4}</body></html>`;
}

// ---------- the free teaser (page 1 only) with the $29 unlock ----------
// Served in place of report.html whenever the audit's slug hasn't been marked paid.
export function buildReportTeaser(data) {
  const lh = data.lighthouse, s = data.site;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(data.name)} · site audit preview</title><style>${CSS}</style></head><body>
  <div class="page">${head(data, subline(data))}
    ${verdict(data)}
    <div class="row">${scoreCell(lh, "Speed", lh.perf)}${scoreCell(lh, "SEO", lh.seo)}${scoreCell(lh, "Accessibility", lh.a11y)}${scoreCell(lh, "Best practices", lh.bp)}
      <div class="sc"><b class="${s.viewport ? "g" : "r"}">${s.viewport ? "yes" : "NO"}</b><span>Mobile layout</span></div></div>
    ${factChips(data)}
    <h2>The ${data.fixes.length} fixes that matter most</h2>
    ${fixList(data.fixes)}
    <div class="paywall" id="paywall">
      <div id="paywallBadge" class="paywallBadge" style="display:none">demo mode: payments not connected</div>
      <p class="paywallCopy">This is the free preview. The full report adds the speed breakdown, the page-by-page SEO table, local presence and trust signals,${data.competition ? ` the head-to-head against ${esc(data.competition.names.join(", ") || "the competitors you named")},` : ""} and the complete prioritized fix list.</p>
      <button id="unlockBtn" class="unlockBtn" type="button">Get the full report: $29</button>
      <p id="paywallMsg" class="paywallErr" style="display:none"></p>
    </div>
    ${foot(data, 1, 1)}
  </div>
  <script>
  (function () {
    var slug = ${JSON.stringify(data.slug)};
    var badge = document.getElementById("paywallBadge");
    var btn = document.getElementById("unlockBtn");
    var msg = document.getElementById("paywallMsg");
    function say(text, ok) { msg.textContent = text; msg.className = "paywallErr" + (ok ? " paywallOk" : ""); msg.style.display = "block"; }
    fetch("/api/checkout/status").then(function (r) { return r.json(); }).then(function (st) {
      if (!st.enabled) { badge.style.display = "block"; btn.disabled = true; btn.title = "Connect a Stripe test key to enable checkout, see PAYMENTS.md."; }
    }).catch(function () {});
    btn.addEventListener("click", function () {
      btn.disabled = true;
      fetch("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: slug }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.url) { window.location = j.url; return; }
          say(j.error || "Checkout is not available right now.", false);
          btn.disabled = false;
        }).catch(function () { say("Checkout is not available right now.", false); btn.disabled = false; });
    });
    var sessionId = new URLSearchParams(window.location.search).get("session_id");
    if (sessionId) {
      say("Confirming payment…", true);
      fetch("/api/checkout/verify?session_id=" + encodeURIComponent(sessionId))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.paid) { window.location = "/out/" + slug + "/report.html"; }
          else { say(j.error || "Payment not confirmed yet.", false); }
        }).catch(function () { say("Could not confirm payment.", false); });
    }
  })();
  </script>
  </body></html>`;
}
