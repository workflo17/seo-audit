#!/usr/bin/env node
// CLI wrapper around the audit core — same pipeline as the paste-a-website UI (server.mjs).
//   node audit.mjs "Example Roofing" https://example-roofing.com \
//        --gphone 555-0100 --town "Red Hook, NY" --competitor https://rival.com \
//        --rating 5.0 --reviews 14
// Output: out/<slug>/ → audit.json · report.html/.pdf · leavebehind.html/.pdf
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit, printPdf } from "./lib.mjs";
import { buildReport, buildLeavebehind } from "./report.mjs";

const argv = process.argv.slice(2);
const positional = argv.filter(a => !a.startsWith("--"));
const flag = n => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : null; };
const name = positional[0], url = positional[1];
if (!name || !url) {
  console.error('usage: node audit.mjs "Business Name" https://site.com [--gphone N] [--town T] [--competitor URL] [--rating R] [--reviews N]');
  process.exit(1);
}

const data = await runAudit(
  { name, url, gphone: flag("gphone"), town: flag("town"), competitor: flag("competitor"), rating: flag("rating"), reviews: flag("reviews") },
  s => console.log("· " + s),
);
const reportHtml = join(data.outDir, "report.html");
const leaveHtml = join(data.outDir, "leavebehind.html");
writeFileSync(reportHtml, buildReport(data));
writeFileSync(leaveHtml, buildLeavebehind(data));
try { printPdf(reportHtml, join(data.outDir, "report.pdf")); } catch { console.log("report PDF failed; HTML written"); }
try { printPdf(leaveHtml, join(data.outDir, "leavebehind.pdf")); } catch { console.log("leave-behind PDF failed; HTML written"); }

console.log(`\n${name} — top fixes:`);
data.fixes.forEach((f, i) => console.log(`  ${i + 1}. ${f.title}`));
if (data.lighthouse.ok) console.log(`  scores: perf ${data.lighthouse.perf} · seo ${data.lighthouse.seo} · a11y ${data.lighthouse.a11y} · bp ${data.lighthouse.bp}`);
console.log("  out: " + data.outDir);
