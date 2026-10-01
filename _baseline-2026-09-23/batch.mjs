#!/usr/bin/env node
// Batch runner: works a prospect list end to end. For each row it runs the pro
// audit (lib-pro.mjs), writes the report, checklist and PDFs (report-pro.mjs,
// lib.mjs), then drafts a plain-text outreach email the owner pastes and sends
// himself. Audits run sequentially, never in parallel, because Lighthouse only
// tolerates one Chrome instance at a time. One bad prospect is recorded as a
// failure and the batch moves on; it never stops the run.
//   node batch.mjs prospects.csv [--pages 30] [--type local|general] [--out dir]
// CSV header (case-insensitive): name, url, town, gphone, competitor, rating,
// reviews, type. Only url is required; name defaults to the hostname. The competitor
// cell takes up to three URLs separated by semicolons.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, printPdf } from "./lib.mjs";
import { buildProReport, buildProChecklist, buildClientReport } from "./report-pro.mjs";
import { archiveRun } from "./history.mjs";
// lib-pro.mjs is loaded lazily inside runBatch, not at module load: the CSV,
// draft and report-builder functions below are pure and have to work (and
// self-test) even on a machine where the deep-audit engine cannot import.
let runProAudit = null;
async function loadRunProAudit() {
  if (!runProAudit) ({ runProAudit } = await import("./lib-pro.mjs"));
  return runProAudit;
}

// ---------- csv ----------
// A small hand-rolled parser rather than a dependency: quoted fields with commas
// or embedded newlines, doubled quotes as an escaped quote, CRLF or LF line ends.
export function parseCsv(text) {
  const s = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* the following \n closes the row */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(c => c !== ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map(h => h.trim().toLowerCase());
  return nonEmpty.slice(1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] === undefined ? "" : r[i]).trim(); });
    return o;
  });
}

// Several competitors fit in the one CSV cell, separated by semicolons or whitespace.
export const competitorList = s => String(s || "").split(/[;\s]+/).map(x => x.trim()).filter(Boolean).slice(0, 3);

const csvField = v => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = arr => arr.map(csvField).join(",");

// ---------- one paperwork bundle per prospect ----------
export function findingsCsv(data) {
  const header = "id,severity,category,title,effort,fix,evidence";
  const lines = (data.findings || []).map((f, i) =>
    csvRow([f.id ?? i + 1, f.sev, f.cat, f.title, f.effort, f.fix, (f.evidence || []).join(" | ")]));
  return [header, ...lines].join("\r\n");
}

export function pagesCsv(data) {
  const header = "path,status,depth,ttfbMs,words,titleLen,metaLen,h1Count,imgCount,imgsWithAlt,noindex,canonical";
  const pages = (data.crawl && data.crawl.pages) || [];
  const lines = pages.map(p => csvRow([
    p.path, p.status, p.depth, p.ttfbMs, p.wordCount, p.titleLen, p.metaLen,
    (p.h1s || []).length, p.imgCount, p.imgsWithAlt, p.noindex ? "yes" : "no", p.canonicalHref || "",
  ]));
  return [header, ...lines].join("\r\n");
}

// A paste-ready email the owner reads over and sends from his own account; this
// script never sends mail. Three short paragraphs, one per top finding: the cost
// in plain terms, then the fix in one sentence.
// Swaps that read correctly wherever the term appears, because each is a plain noun
// standing in for a technical one. Anything needing a reworded sentence is not on this
// list: a sentence that still carries jargon after these is dropped rather than mangled.
const PLAIN = [
  [/\bmarked noindex\b/gi, "hidden from search"],
  [/\bnoindex meta tag\b/gi, "hidden-from-search tag"],
  [/\bJSON-LD\b/gi, "business schema"],
  [/\bLocalBusiness schema\b/gi, "business schema"],
  [/\bGA4\b/gi, "Google Analytics"],
  [/\btel: ?links?\b/gi, "tap-to-call links"],
  [/\bOpen Graph\b/gi, "social preview tags"],
  [/\bTTFB\b/gi, "server response time"],
];
const JARGON = /X-Robots-Tag|\bnoindex\b|\bcanonical\b|\bCDN\b|\bschema\.org\b|\bLCP\b|\bCLS\b/i;
const plainly = s => PLAIN.reduce((acc, [re, to]) => acc.replace(re, to), String(s || "")).replace(/\s+/g, " ").trim();

// A cold email opens a conversation; it does not hand over the work list. Each paragraph
// names one problem and says what it costs, and the fixes stay in the report.
export function outreachDraft(data) {
  const name = data.name || "there";
  const top = (data.findings || []).slice(0, 3);
  const lines = [
    `Hi ${name},`,
    "",
    "I took a look at your website today and want to flag a few things worth fixing.",
    "",
  ];
  for (const f of top) {
    const title = plainly(f.title).replace(/\.$/, "");
    const cost = plainly(f.cost);
    const opener = title.charAt(0).toUpperCase() + title.slice(1);
    // Keep the explanation only when it survives in plain English.
    lines.push(cost && !JARGON.test(cost) ? `${opener}. ${cost}` : `${opener}.`);
    lines.push("");
  }
  const rest = Math.max(0, (data.findings || []).length - top.length);
  if (rest) lines.push(`There are ${rest} more, most of them small. I put the whole list in a short report with what each one costs to fix.`);
  else lines.push("I put the detail in a short report with what each one costs to fix.");
  lines.push("");
  lines.push("Happy to walk through it on a 15 minute call if that is useful.");
  lines.push("");
  lines.push("[your name]");
  lines.push("[your phone]");
  return lines.join("\n") + "\n";
}

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- the ranked index page ----------
export function batchIndexHtml(results, failures = []) {
  const ranked = results.map(r => ({ ...r, opportunity: 100 - (r.scores?.overall ?? 0) }))
    .sort((a, b) => b.opportunity - a.opportunity);
  const rows = ranked.map((r, i) => {
    const s = r.scores || {};
    const top = (r.top || []).slice(0, 3).map(t => `<li>${esc(t)}</li>`).join("");
    const slug = esc(r.slug || "");
    return `<tr>
      <td>${i + 1}</td>
      <td>${esc(r.name)}<div class="url"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></div></td>
      <td class="num">${s.overall ?? ""}</td>
      <td class="num">${s.speed ?? ""}</td>
      <td class="num">${s.content ?? ""}</td>
      <td class="num">${s.tech ?? ""}</td>
      <td class="num">${s.local ?? ""}</td>
      <td class="num">${s.trust ?? ""}</td>
      <td><ul class="findings">${top}</ul></td>
      <td class="links"><a href="../../${slug}/report-pro.html">report</a><br><a href="../../${slug}/checklist.pdf">checklist</a></td>
    </tr>`;
  }).join("\n");
  const failRows = failures.map(f => `<tr><td>${esc(f.name)}</td><td>${esc(f.url)}</td><td>${esc(f.error)}</td></tr>`).join("\n");
  const failSection = failures.length ? `
  <h2>Failed</h2>
  <table>
    <thead><tr><th>Name</th><th>URL</th><th>Error</th></tr></thead>
    <tbody>${failRows}</tbody>
  </table>` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Batch audit results</title>
<style>
body { font-family: -apple-system, Segoe UI, Arial, sans-serif; margin: 2rem; color: #1a1a1a; background: #fafafa; }
h1 { margin-bottom: 0.2rem; }
.sub { color: #666; margin-top: 0; margin-bottom: 1.5rem; }
table { border-collapse: collapse; width: 100%; background: #fff; }
th, td { border: 1px solid #ddd; padding: 0.5rem 0.6rem; text-align: left; vertical-align: top; font-size: 0.9rem; }
th { background: #f0f0f0; }
td.num { text-align: center; }
.url { color: #666; font-size: 0.8rem; }
.url a { color: inherit; }
ul.findings { margin: 0; padding-left: 1.1rem; }
td.links a { display: inline-block; margin-right: 0.4rem; }
h2 { margin-top: 2.5rem; }
</style></head>
<body>
<h1>Batch audit results</h1>
<p class="sub">${ranked.length} audited, sorted by opportunity (100 minus overall score), highest first.</p>
<table>
  <thead><tr><th>Rank</th><th>Business</th><th>Overall</th><th>Speed</th><th>Content</th><th>Tech</th><th>Local</th><th>Trust</th><th>Top findings</th><th>Links</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
${failSection}
</body></html>`;
}

// ---------- run the audits ----------
export async function runBatch(rows, { maxPages, type, findCompetitors = false, batchDir, log = () => {} } = {}) {
  mkdirSync(batchDir, { recursive: true });
  const audit = await loadRunProAudit();
  const results = [];
  const failures = [];
  for (const [i, row] of rows.entries()) {
    const url = (row.url || "").trim();
    const name = (row.name || "").trim() || (() => { try { return new URL(url).hostname; } catch { return url || "unknown"; } })();
    log(`[${i + 1}/${rows.length}] ${name}`);
    if (!url) { failures.push({ name, url, error: "missing url" }); log("  skipped: missing url"); continue; }
    try {
      const opts = {
        name, url, maxPages,
        gphone: row.gphone || undefined,
        town: row.town || undefined,
        competitors: competitorList(row.competitor),
        findCompetitors,
        rating: row.rating || undefined,
        reviews: row.reviews || undefined,
        type: (row.type || type || undefined),
      };
      const data = await audit(opts, s => log("  - " + s));
      const reportHtml = join(data.outDir, "report-pro.html");
      const checkHtml = join(data.outDir, "checklist.html");
      const clientHtml = join(data.outDir, "report-client.html");
      writeFileSync(reportHtml, buildProReport(data));
      writeFileSync(clientHtml, buildClientReport(data));
      writeFileSync(checkHtml, buildProChecklist(data));
      try { printPdf(reportHtml, join(data.outDir, "report-pro.pdf")); } catch (e) { log("  report PDF failed: " + (e.message || e)); }
      try { printPdf(clientHtml, join(data.outDir, "report-client.pdf")); } catch (e) { log("  client PDF failed: " + (e.message || e)); }
      try { printPdf(checkHtml, join(data.outDir, "checklist.pdf")); } catch (e) { log("  checklist PDF failed: " + (e.message || e)); }
      writeFileSync(join(data.outDir, "outreach.txt"), outreachDraft(data));
      writeFileSync(join(data.outDir, "findings.csv"), findingsCsv(data));
      writeFileSync(join(data.outDir, "pages.csv"), pagesCsv(data));
      // Every batch run is archived so the next pass over the same list can show what changed.
      archiveRun(data.outDir, data.stamp);
      results.push({
        name: data.name, url: data.url, slug: data.slug, scores: data.scores,
        top: (data.findings || []).slice(0, 3).map(f => f.title), outDir: data.outDir,
      });
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 400);
      failures.push({ name, url, error: msg });
      log("  FAILED: " + msg);
    }
  }
  return { results, failures, batchDir };
}

// ---------- self-test ----------
async function selftest() {
  let pass = 0, fail = 0;
  const check = (label, ok) => { console.log((ok ? "PASS" : "FAIL") + " " + label); ok ? pass++ : fail++; };

  const csvText = 'Name,URL,Town\r\n"Ace, Inc.",https://ace.example,"Red Hook, NY"\r\nBob Roofing,https://bob.example,Troy\r\n';
  const parsed = parseCsv(csvText);
  check("parseCsv: row count", parsed.length === 2);
  check("parseCsv: quoted comma field", parsed[0]?.name === "Ace, Inc.");
  check("parseCsv: quoted town field", parsed[0]?.town === "Red Hook, NY");
  check("parseCsv: plain row after CRLF", parsed[1]?.name === "Bob Roofing" && parsed[1]?.url === "https://bob.example");
  check("parseCsv: header lowercased", Object.keys(parsed[0]).includes("url"));
  check("competitorList: splits on semicolons and spaces, caps at three",
    competitorList("https://a.example; https://b.example https://c.example;https://d.example").join(",") === "https://a.example,https://b.example,https://c.example");
  check("competitorList: empty cell gives an empty list", competitorList("").length === 0 && competitorList(undefined).length === 0);

  const synthetic = {
    name: "Ace Roofing",
    url: "https://ace-roofing.example",
    slug: "ace-roofing",
    outDir: "out/ace-roofing",
    scores: { overall: 62, speed: 70, content: 55, tech: 60, local: 65, trust: 68 },
    findings: [
      { id: 1, sev: "critical", cat: "speed", title: "Mobile speed scores 42/100",
        cost: "Slow pages bleed visitors before they see the work.",
        fix: "Compress hero images and defer non-critical scripts.", effort: "1-2 days", evidence: ["LCP 5.2s"] },
      { id: 2, sev: "high", cat: "content", title: "3 pages have no meta description, and titles, are missing",
        cost: "Google improvises the snippet under the listing, and improvised snippets do not sell.",
        fix: "Write a 150 character description for each page.", effort: "half a day", evidence: [] },
      { id: 3, sev: "medium", cat: "local", title: "No tap to call link anywhere on the site",
        cost: "A number that cannot be tapped is a number most people will not dial.",
        fix: "Wrap every phone number in a tel link.", effort: "1 hour", evidence: [] },
    ],
    crawl: { pages: [
      { path: "/", status: 200, depth: 0, ttfbMs: 320, wordCount: 540, titleLen: 52, metaLen: 140,
        h1s: ["Ace Roofing"], imgCount: 8, imgsWithAlt: 5, noindex: false, canonicalHref: "https://ace-roofing.example/" },
      { path: "/services.html", status: 200, depth: 1, ttfbMs: 410, wordCount: 320, titleLen: 48, metaLen: 0,
        h1s: [], imgCount: 3, imgsWithAlt: 1, noindex: false, canonicalHref: null },
    ] },
  };

  const draft = outreachDraft(synthetic);
  const wordCount = draft.trim().split(/\s+/).filter(Boolean).length;
  check("outreachDraft: contains business name", draft.includes("Ace Roofing"));
  check("outreachDraft: no em or en dash", !draft.includes("—") && !draft.includes("–"));
  check("outreachDraft: under 220 words", wordCount < 220);
  // The draft names the problems and leaves the fixes in the report: a cold email opens
  // a conversation rather than handing over the work list.
  check("outreachDraft: names all three problems", synthetic.findings.every(f => draft.includes(f.title.replace(/\.$/, ""))));
  check("outreachDraft: withholds the fixes", synthetic.findings.every(f => !draft.includes(f.fix)));
  check("outreachDraft: no leftover jargon", !/X-Robots-Tag|JSON-LD|\bnoindex\b|\bGA4\b|\bTTFB\b/i.test(draft));

  const fc = findingsCsv(synthetic);
  const fcLines = fc.split("\r\n");
  check("findingsCsv: header", fcLines[0] === "id,severity,category,title,effort,fix,evidence");
  check("findingsCsv: row count", fcLines.length === 1 + synthetic.findings.length);
  check("findingsCsv: quotes a title with commas", fcLines[2].includes('"3 pages have no meta description, and titles, are missing"'));

  const pc = pagesCsv(synthetic);
  const pcLines = pc.split("\r\n");
  check("pagesCsv: header", pcLines[0] === "path,status,depth,ttfbMs,words,titleLen,metaLen,h1Count,imgCount,imgsWithAlt,noindex,canonical");
  check("pagesCsv: row count", pcLines.length === 1 + synthetic.crawl.pages.length);
  check("pagesCsv: h1Count derived from h1s array", pcLines[1].split(",")[7] === "1");

  const low = { name: "Low Score Co", url: "https://low.example", slug: "low-score-co",
    scores: { overall: 40, speed: 40, content: 40, tech: 40, local: 40, trust: 40 },
    top: ["Finding A", "Finding B", "Finding C"], outDir: "out/low-score-co" };
  const high = { name: "High Score Co", url: "https://high.example", slug: "high-score-co",
    scores: { overall: 90, speed: 90, content: 90, tech: 90, local: 90, trust: 90 },
    top: ["Finding D", "Finding E", "Finding F"], outDir: "out/high-score-co" };
  const idxHtml = batchIndexHtml([high, low], []);
  check("batchIndexHtml: lower score ranked first", idxHtml.indexOf("Low Score Co") < idxHtml.indexOf("High Score Co"));
  check("batchIndexHtml: links point at ../../<slug>/report-pro.html", idxHtml.includes("../../low-score-co/report-pro.html"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---------- CLI ----------
async function main() {
  const argv = process.argv.slice(2);
  const flag = n => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : null; };
  const csvPath = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  if (!csvPath) {
    console.error("usage: node batch.mjs prospects.csv [--pages 30] [--type local|general] [--find-competitors] [--out dir] [--stamp name]");
    process.exit(1);
  }
  const maxPages = flag("pages") ? +flag("pages") : 30;
  const type = flag("type") || undefined;
  const findCompetitors = argv.includes("--find-competitors");
  const stamp = flag("stamp") || new Date().toISOString().replace(/[:.]/g, "-");
  const batchDir = flag("out") ? resolve(flag("out")) : join(ROOT, "out", "_batch", stamp);

  const rows = parseCsv(readFileSync(resolve(csvPath), "utf8"));
  if (!rows.length) { console.error("no rows found in " + csvPath); process.exit(1); }

  const t0 = Date.now();
  const { results, failures } = await runBatch(rows, { maxPages, type, findCompetitors, batchDir, log: console.log });

  writeFileSync(join(batchDir, "index.html"), batchIndexHtml(results, failures));
  const summaryHeader = "rank,name,url,overall,speed,content,tech,local,trust,top1,top2,top3,outDir";
  const ranked = results.map(r => ({ ...r, opportunity: 100 - (r.scores?.overall ?? 0) })).sort((a, b) => b.opportunity - a.opportunity);
  const summaryLines = ranked.map((r, i) => csvRow([
    i + 1, r.name, r.url, r.scores?.overall, r.scores?.speed, r.scores?.content, r.scores?.tech, r.scores?.local, r.scores?.trust,
    r.top?.[0] || "", r.top?.[1] || "", r.top?.[2] || "", r.outDir,
  ]));
  writeFileSync(join(batchDir, "summary.csv"), [summaryHeader, ...summaryLines].join("\r\n"));
  writeFileSync(join(batchDir, "failures.json"), JSON.stringify(failures, null, 2));

  console.log(`\n${results.length} audited, ${failures.length} failed, ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log("out: " + batchDir);
}

// pathToFileURL, not a hand-built string: on Windows a path becomes file:///C:/... with
// three slashes, so the naive comparison never matched and the CLI silently did nothing.
if (process.argv.includes("--selftest")) await selftest();
else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
