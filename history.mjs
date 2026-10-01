// Run history: out/<slug>/ is overwritten on every audit, so this keeps a copy of
// each run's report and JSON in out/<slug>/runs/<stamp>/ and diffs two runs so the
// next report can say what changed since last time. Zero npm dependencies.
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const FILES = ["audit-pro.json", "report-pro.html", "report-pro.pdf", "checklist.html",
  "checklist.pdf", "lighthouse.json", "lighthouse-desktop.json"];
const MAX_RUNS = 24;

// Copies the run's output files into out/<slug>/runs/<stamp>/, then prunes to the
// newest MAX_RUNS runs. stamp is caller-supplied so this stays a pure copy, no clock.
export function archiveRun(outDir, stamp) {
  try {
    const runsDir = join(outDir, "runs");
    const runDir = join(runsDir, stamp);
    mkdirSync(runDir, { recursive: true });
    for (const f of FILES) {
      const src = join(outDir, f);
      if (existsSync(src)) copyFileSync(src, join(runDir, f));
    }
    const dirs = readdirSync(runsDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name).sort();
    const excess = dirs.length - MAX_RUNS;
    if (excess > 0) for (const name of dirs.slice(0, excess)) rmSync(join(runsDir, name), { recursive: true, force: true });
    return runDir;
  } catch { return null; }
}

function readRunJson(runDir) {
  try { return JSON.parse(readFileSync(join(runDir, "audit-pro.json"), "utf8")); } catch { return null; }
}

// Every archived run, newest stamp first. A run whose audit-pro.json is missing or
// unreadable (partial copy, corrupt file) is skipped rather than breaking the list.
export function listRuns(outDir) {
  const runsDir = join(outDir, "runs");
  let names;
  try { names = readdirSync(runsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
  const out = [];
  for (const stamp of names.sort().reverse()) {
    const dir = join(runsDir, stamp);
    const data = readRunJson(dir);
    if (!data) continue;
    out.push({ dir, stamp, date: data.date ?? null, scores: data.scores ?? null,
      findings: data.findings ?? [], pages: data.crawl?.pages ?? [] });
  }
  return out;
}

// The newest run other than excludeStamp (the run currently being written), or null
// when this is the first run. Used to build the "what changed" diff for the report.
export function previousRun(outDir, excludeStamp) {
  const runsDir = join(outDir, "runs");
  let names;
  try { names = readdirSync(runsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return null; }
  for (const stamp of names.sort().reverse()) {
    if (stamp === excludeStamp) continue;
    const dir = join(runsDir, stamp);
    const data = readRunJson(dir);
    if (data) return { dir, stamp, data };
  }
  return null;
}

// The folder is named after the business, so an audit run under another name ("examplebrand"
// one day, "Example Brand" the next) used to start with no history. When this site's own folder
// has nothing earlier, every other folder's archived runs are checked for the same host, and
// the newest one before this run is used.
const hostKey = u => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
export function previousRunForHost(root, url, excludeStamp) {
  const want = hostKey(url);
  if (!want) return null;
  let dirs;
  try { dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith("_")).map(d => d.name); }
  catch { return null; }
  let best = null;
  for (const name of dirs) {
    for (const r of listRuns(join(root, name))) {
      if (r.stamp === excludeStamp || (excludeStamp && r.stamp > excludeStamp)) continue;
      if (best && r.stamp <= best.stamp) continue;
      const data = readRunJson(r.dir);
      if (data && hostKey(data.url) === want) best = { dir: r.dir, stamp: r.stamp, data, folder: name };
    }
  }
  return best;
}

// Findings rename their wording between runs ("3 pages have no meta description" becomes
// "1 page has no meta description" once two get fixed): the count changes and so does the
// plural agreement around it. An id match wins when both sides have one; otherwise the
// fallback identity drops digits, drops count-agreement stopwords (has/have/is/are/...),
// and un-pluralizes what is left, so both titles above reduce to the same key.
const COUNT_STOPWORDS = new Set(["has", "have", "is", "are", "was", "were", "a", "an", "the", "of", "on"]);
function findingKey(f) {
  if (f.id != null) return `id:${f.id}`;
  const words = String(f.title ?? "").toLowerCase().replace(/\d+/g, " ").split(/[^a-z]+/)
    .filter(w => w && !COUNT_STOPWORDS.has(w))
    .map(w => (w.length > 3 && w.endsWith("s")) ? w.slice(0, -1) : w);
  return "t:" + words.join(" ");
}

function delta(a, b) {
  if (a == null || b == null) return null;
  return b - a;
}

// Compares two audit-pro.json payloads: score movement per category, findings resolved
// since prevData / newly added in curData / persisting in both, and page/link count moves.
export function diffRuns(prevData, curData) {
  const prevScores = prevData.scores ?? {};
  const curScores = curData.scores ?? {};
  const cats = ["speed", "content", "tech", "local", "trust", "overall"];
  const scoreDelta = {};
  for (const c of cats) scoreDelta[c] = delta(prevScores[c] ?? null, curScores[c] ?? null);

  const prevFindings = prevData.findings ?? [];
  const curFindings = curData.findings ?? [];
  const prevMap = new Map(prevFindings.map(f => [findingKey(f), f]));
  const curMap = new Map(curFindings.map(f => [findingKey(f), f]));

  const resolved = [], added = [];
  let persisting = 0;
  for (const [key, f] of prevMap) {
    if (curMap.has(key)) persisting++;
    else resolved.push({ id: f.id ?? null, title: f.title, sev: f.sev });
  }
  for (const [key, f] of curMap) {
    if (!prevMap.has(key)) added.push({ id: f.id ?? null, title: f.title, sev: f.sev });
  }

  const prevPages = prevData.crawl?.pages?.length ?? null;
  const curPages = curData.crawl?.pages?.length ?? null;
  const pagesDelta = delta(prevPages, curPages);
  const prevBroken = prevData.links?.brokenInternal ?? null;
  const curBroken = curData.links?.brokenInternal ?? null;
  const brokenLinksDelta = delta(prevBroken, curBroken);

  const prevOverall = prevScores.overall ?? "?";
  const curOverall = curScores.overall ?? "?";
  const bits = [`Health moved from ${prevOverall} to ${curOverall}`];
  const parts = [];
  if (resolved.length) parts.push(`${resolved.length} finding${resolved.length === 1 ? "" : "s"} resolved`);
  if (added.length) parts.push(`${added.length} new`);
  const summary = parts.length ? `${bits[0]}: ${parts.join(", ")}.` : `${bits[0]}, no finding changes.`;

  return {
    prevDate: prevData.date ?? null, curDate: curData.date ?? null, scoreDelta,
    resolved, added, persisting, pagesDelta, brokenLinksDelta, summary,
  };
}

// ---------- self-test ----------
if (process.argv.includes("--selftest")) {
  const os = await import("node:os");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}`); } };

  const outDir = mkdtempSync(join(os.tmpdir(), "history-selftest-"));

  const runA = {
    date: "2026-08-30",
    scores: { speed: 60, content: 70, tech: 50, local: 80, trust: 65, overall: 47 },
    findings: [
      { id: "f1", title: "3 pages have no meta description", sev: "med" },
      { id: "f2", title: "Missing H1 on the contact page", sev: "low" },
      { id: "f3", title: "No SSL certificate", sev: "high" },
    ],
    crawl: { pages: [{ path: "/" }, { path: "/about.html" }, { path: "/services.html" }] },
    links: { brokenInternal: 2 },
  };
  writeFileSync(join(outDir, "audit-pro.json"), JSON.stringify(runA));
  const dirA = archiveRun(outDir, "A");
  check("archiveRun A returns a run dir", !!dirA && existsSync(join(dirA, "audit-pro.json")));

  const runB = {
    date: "2026-09-01",
    scores: { speed: 75, content: 70, tech: 65, local: 80, trust: 65, overall: 61 },
    findings: [
      { id: "f2", title: "Missing H1 on the contact page", sev: "low" },
      { id: "f3", title: "No SSL certificate", sev: "high" },
      { id: "f4", title: "Sitemap missing 2 pages", sev: "med" },
    ],
    crawl: { pages: [{ path: "/" }, { path: "/about.html" }, { path: "/services.html" }, { path: "/contact.html" }] },
    links: { brokenInternal: 1 },
  };
  writeFileSync(join(outDir, "audit-pro.json"), JSON.stringify(runB));
  const dirB = archiveRun(outDir, "B");
  check("archiveRun B returns a run dir", !!dirB && existsSync(join(dirB, "audit-pro.json")));

  const runs = listRuns(outDir);
  check("listRuns returns 2 runs", runs.length === 2);
  check("listRuns is newest first", runs[0]?.stamp === "B" && runs[1]?.stamp === "A");

  const prev = previousRun(outDir, "B");
  check("previousRun(outDir, B) picks A", prev && prev.stamp === "A");

  const d = diffRuns(prev.data, runB);
  check("diffRuns resolves f1", d.resolved.length === 1 && d.resolved[0].id === "f1");
  check("diffRuns adds f4", d.added.length === 1 && d.added[0].id === "f4");
  check("diffRuns persisting is 2", d.persisting === 2);
  check("diffRuns overall delta is 14", d.scoreDelta.overall === 14);
  check("diffRuns pagesDelta is 1", d.pagesDelta === 1);
  check("diffRuns brokenLinksDelta is -1", d.brokenLinksDelta === -1);
  check("diffRuns summary mentions 47 to 61", d.summary.includes("47 to 61"));

  // Title-based match: "3 pages have no meta description" vs a later reworded finding
  // with the same stripped key should count as persisting, not resolved+added.
  const prevTitleOnly = { scores: {}, findings: [{ title: "3 pages have no meta description" }] };
  const curTitleOnly = { scores: {}, findings: [{ title: "1 page has no meta description" }] };
  const dTitle = diffRuns(prevTitleOnly, curTitleOnly);
  check("diffRuns matches findings by stripped title", dTitle.resolved.length === 0 && dTitle.added.length === 0 && dTitle.persisting === 1);

  for (let i = 0; i < 26; i++) {
    writeFileSync(join(outDir, "audit-pro.json"), JSON.stringify({ ...runB, date: `2026-09-${String(i).padStart(2, "0")}` }));
    archiveRun(outDir, `run-${String(i).padStart(3, "0")}`);
  }
  const remaining = readdirSync(join(outDir, "runs"), { withFileTypes: true }).filter(d => d.isDirectory());
  check("archiveRun prunes to 24 runs max", remaining.length === 24);

  // Two folders for one host: the newest earlier run is found whatever the folder is called.
  const root = mkdtempSync(join(os.tmpdir(), "history-host-"));
  const put = (folder, stamp, url) => {
    const dir = join(root, folder); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "audit-pro.json"), JSON.stringify({ ...runA, url }));
    archiveRun(dir, stamp);
  };
  put("examplebrand", "2026-09-22T2004", "https://examplebrand.example");
  put("example-brand", "2026-09-23T2130", "https://www.examplebrand.example");
  put("someone-else", "2026-09-23T2200", "https://other.example");
  mkdirSync(join(root, "_batch"), { recursive: true });
  const byHost = previousRunForHost(root, "https://examplebrand.example/", "2026-09-24T0900");
  check("previousRunForHost finds the newest run of the host in any folder", byHost && byHost.folder === "example-brand" && byHost.stamp === "2026-09-23T2130");
  const older = previousRunForHost(root, "https://examplebrand.example/", "2026-09-23T2130");
  check("previousRunForHost skips the current stamp and anything after it", older && older.folder === "examplebrand");
  check("previousRunForHost ignores other hosts", previousRunForHost(root, "https://nobody.example/", "2026-09-24T0900") === null);
  rmSync(root, { recursive: true, force: true });

  rmSync(outDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
