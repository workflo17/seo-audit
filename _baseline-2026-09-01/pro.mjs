#!/usr/bin/env node
// Full audit CLI: the owner-only deep pipeline (lib-pro.mjs). Nothing about this
// path is reachable from the public demo: it is not paywalled, not teased, and the
// server only exposes it to loopback (see PRO.md).
//   node pro.mjs "Example Roofing" https://example-roofing.com \
//        --pages 60 --gphone 555-0100 --town "Red Hook, NY" \
//        --competitor https://rival.com --competitor https://other.com --rating 5.0 --reviews 14
// Output: out/<slug>/ → audit-pro.json · report-pro.html/.pdf · checklist.html/.pdf
//                       lighthouse.json + lighthouse-desktop.json (raw)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { printPdf } from "./lib.mjs";
import { runProAudit } from "./lib-pro.mjs";
import { buildProReport, buildProChecklist } from "./report-pro.mjs";

const argv = process.argv.slice(2);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const flag = n => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : null; };
const flagAll = n => argv.reduce((a, v, i) => (v === "--" + n ? [...a, argv[i + 1]] : a), []);
let [name, url] = positional;
if (!url && /^https?:\/\//i.test(name || "")) { url = name; name = null; }
if (!url) {
  console.error('usage: node pro.mjs "Business Name" https://site.com [--pages 40] [--gphone N] [--town T] [--competitor URL]... [--rating R] [--reviews N]');
  process.exit(1);
}
if (!name) name = new URL(url).hostname.replace(/^www\./, "").split(".")[0].replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());

const t0 = Date.now();
const data = await runProAudit({
  name, url, maxPages: flag("pages"), gphone: flag("gphone"), town: flag("town"),
  competitors: flagAll("competitor"), rating: flag("rating"), reviews: flag("reviews"),
}, s => console.log("· " + s));

const reportHtml = join(data.outDir, "report-pro.html");
const checkHtml = join(data.outDir, "checklist.html");
writeFileSync(reportHtml, buildProReport(data));
writeFileSync(checkHtml, buildProChecklist(data));
try { printPdf(reportHtml, join(data.outDir, "report-pro.pdf")); } catch { console.log("report PDF failed; HTML written"); }
try { printPdf(checkHtml, join(data.outDir, "checklist.pdf")); } catch { console.log("checklist PDF failed; HTML written"); }

const s = data.scores;
console.log(`\n${name}: health ${s.overall}/100 (speed ${s.speed} · content ${s.content} · technical ${s.tech} · local ${s.local} · trust ${s.trust})`);
const n = data.crawl.pages.length;
console.log(`  ${n} page${n === 1 ? "" : "s"} crawled · ${data.crawl.linksChecked} links checked · ${data.links.brokenInternal + data.links.brokenExternal} dead · ${data.findings.length} findings`);
data.fixes.forEach((f, i) => console.log(`  ${i + 1}. [${f.sev}] ${f.title}`));
console.log(`  ${Math.round((Date.now() - t0) / 1000)}s · out: ${data.outDir}`);
