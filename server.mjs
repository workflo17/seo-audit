// Paste-a-website audit server (:4950). GET / serves the form; POST /run queues
// an audit job; GET /status polls it; results live under /out/<slug>/.
// The full report is paywalled behind a $29 Stripe Checkout (test mode until a real
// key is set) — see PAYMENTS.md for how the key plugs in and how checkout works.
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { ROOT, runAudit, printPdf } from "./lib.mjs";
import { buildReport, buildLeavebehind, buildReportTeaser } from "./report.mjs";
import { runProAudit } from "./lib-pro.mjs";
import { buildProReport, buildProChecklist } from "./report-pro.mjs";
import { archiveRun, listRuns, diffRuns } from "./history.mjs";
import { parseCsv, runBatch, outreachDraft, findingsCsv, pagesCsv, batchIndexHtml } from "./batch.mjs";
import { hostOf } from "./discover.mjs";

// One line for the result panel: which competitors a search found, then the head-to-head.
function competeLine(discovery, line) {
  const bits = [];
  if (discovery && discovery.picked.length) bits.push(`Found ${discovery.picked.map(hostOf).join(", ")} by searching for "${discovery.queries[0]}".`);
  else if (discovery && discovery.note) bits.push(discovery.note);
  if (line) bits.push(line);
  return bits.length ? bits.join(" ") : null;
}

// buildClientReport is landing in report-pro.mjs from another agent's work in
// parallel. Import it dynamically so this server still boots (and every other
// route still works) whether or not that export has arrived yet.
let buildClientReport = null;
try { ({ buildClientReport } = await import("./report-pro.mjs")); } catch {}

// .env loader — no npm deps, just KEY=VALUE lines. Existing process.env wins over the file.
function loadEnv(path = join(ROOT, ".env")) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let [, key, val] = m;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const PORT = process.env.PORT ? Number(process.env.PORT) : 4950;
const OUT_DIR = join(ROOT, "out");
const JOBS_FILE = join(OUT_DIR, "_jobs.json");
const SHARES_FILE = join(OUT_DIR, "_shares.json");
const MAX_JOBS = 200;

const paidSlugs = new Set();     // slug -> unlocked full report (scaffold; see PAYMENTS.md TODOs)

const MIME = { html: "text/html; charset=utf-8", json: "application/json; charset=utf-8", pdf: "application/pdf" };
const send = (res, code, body, type = "json") => {
  res.writeHead(code, { "content-type": MIME[type] || "text/plain" });
  res.end(type === "json" ? JSON.stringify(body) : body);
};

// Stripe's REST API wants classic form-encoding with bracket notation for nested
// objects/arrays (line_items[0][price_data][currency]=usd) — flatten by hand, no SDK.
const stripeForm = (obj, prefix = "") => Object.entries(obj)
  .map(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k;
    return v && typeof v === "object" ? stripeForm(v, key) : `${encodeURIComponent(key)}=${encodeURIComponent(v)}`;
  }).join("&");

const GATED_FILES = new Set(["report.html", "report.pdf", "audit.json"]); // behind the $29 unlock
// The deep audit and everything it writes stay mine: not sold, not teased.
const OWNER_FILES = new Set(["report-pro.html", "report-pro.pdf", "checklist.html", "checklist.pdf",
                             "audit-pro.json", "lighthouse.json", "lighthouse-desktop.json",
                             "report-client.html", "report-client.pdf", "outreach.txt", "findings.csv", "pages.csv"]);

// Owner = same machine (loopback), or an explicit OWNER_KEY header if this ever gets
// exposed beyond localhost. No key in .env means no remote owner access at all.
function isOwner(req) {
  const ra = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (ra === "127.0.0.1" || ra === "::1") return true;
  const key = process.env.OWNER_KEY;
  return Boolean(key) && (req.headers["x-owner-key"] === key || new URL(req.url, "http://x").searchParams.get("key") === key);
}

// ---------- SSRF guard ----------
// The owner can point this at his own machine (the fixture lives on localhost); nobody
// else gets to make this server fetch an address it can reach but the internet can't.
function isPrivateHost(host) {
  const h = String(host || "").toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "::") return true;
  if (/\.(local|internal|localhost)$/.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (h.includes(":")) {
    const first = parseInt(h.split(":")[0] || "0", 16) || 0;
    if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7
    if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10
  }
  return false;
}
function ssrfBlocked(urlStr) {
  let target;
  try { target = new URL(urlStr); } catch { return "that does not look like a valid URL"; }
  if (!/^https?:$/.test(target.protocol)) return "only http and https URLs are allowed";
  if (isPrivateHost(target.hostname)) return "that address is not reachable from here";
  return null;
}

// ---------- path safety for /out/ ----------
function safeOutPath(parts) {
  for (const p of parts) { if (!p || p.includes("..") || p.includes("\\")) return null; }
  const file = resolve(OUT_DIR, ...parts);
  const base = resolve(OUT_DIR) + sep;
  if (!file.startsWith(base)) return null;
  return file;
}

// ---------- job queue ----------
// One job runs at a time (Lighthouse only tolerates one Chrome instance); everything
// else waits its turn in a FIFO. Persisted to disk so a restart doesn't lose the list.
const jobs = new Map();   // id -> job
const queue = [];         // ids waiting to run
let pumping = false;

function trimJobs() {
  if (jobs.size <= MAX_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.status === "done" || job.status === "error") jobs.delete(id);
  }
}
function saveJobs() {
  try { mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(JOBS_FILE, JSON.stringify([...jobs.values()])); } catch {}
}
function loadJobs() {
  if (!existsSync(JOBS_FILE)) return;
  try {
    for (const j of JSON.parse(readFileSync(JOBS_FILE, "utf8"))) {
      if (j.status === "running") { j.status = "error"; j.error = j.error || "server restarted"; j.done = true; }
      jobs.set(j.id, j);
      if (j.status === "queued") queue.push(j.id);
    }
  } catch {}
}

function enqueueJob(kind, opts) {
  const id = randomUUID();
  const job = { id, kind, opts, stages: ["Queued…"], done: false, error: null, slug: null, status: "queued" };
  jobs.set(id, job);
  queue.push(id);
  trimJobs();
  saveJobs();
  pump();
  return job;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job) continue;
    job.status = "running";
    job.stages.push(job.kind === "batch" ? "Batch starting…" : "Starting…");
    saveJobs();
    try {
      if (job.kind === "batch") await runBatchJob(job);
      else await runJob(job);
    } catch (e) {
      job.error = String(e.message || e);
    }
    job.done = true;
    job.status = job.error ? "error" : "done";
    saveJobs();
  }
  pumping = false;
}

async function runJob(job) {
  const opts = job.opts;
  try {
    if (opts.mode === "pro") return await runProJob(job);
    const data = await runAudit(opts, s => job.stages.push(s));
    job.stages.push("Building the report…");
    const reportHtml = join(data.outDir, "report.html");
    const teaserHtml = join(data.outDir, "report-teaser.html");
    const leaveHtml = join(data.outDir, "leavebehind.html");
    writeFileSync(reportHtml, buildReport(data));
    writeFileSync(teaserHtml, buildReportTeaser(data));
    writeFileSync(leaveHtml, buildLeavebehind(data));
    job.stages.push("Printing PDFs…");
    try { printPdf(reportHtml, join(data.outDir, "report.pdf")); } catch { job.stages.push("(report PDF failed; HTML is fine)"); }
    try { printPdf(leaveHtml, join(data.outDir, "leavebehind.pdf")); } catch { job.stages.push("(leave-behind PDF failed; HTML is fine)"); }
    job.slug = data.slug;
    job.top = data.fixes.map(f => f.title);
    job.scores = data.lighthouse.ok ? { perf: data.lighthouse.perf, seo: data.lighthouse.seo } : null;
    job.compete = competeLine(data.discovery, data.competition ? data.competition.summary.line : null);
    job.stages.push("Done.");
  } catch (e) {
    job.error = String(e.message || e);
  }
}

// The deep pipeline: no teaser, no paywall, every report format, plus history.
async function runProJob(job) {
  const opts = job.opts;
  const data = await runProAudit(opts, s => job.stages.push(s));
  job.stages.push("Building the full report…");
  const reportHtml = join(data.outDir, "report-pro.html");
  const checkHtml = join(data.outDir, "checklist.html");
  writeFileSync(reportHtml, buildProReport(data));
  writeFileSync(checkHtml, buildProChecklist(data));
  job.stages.push("Printing PDFs…");
  try { printPdf(reportHtml, join(data.outDir, "report-pro.pdf")); } catch { job.stages.push("(report PDF failed; HTML is fine)"); }
  try { printPdf(checkHtml, join(data.outDir, "checklist.pdf")); } catch { job.stages.push("(checklist PDF failed; HTML is fine)"); }
  let hasClient = false;
  if (typeof buildClientReport === "function") {
    job.stages.push("Building the client report…");
    const clientHtml = join(data.outDir, "report-client.html");
    try {
      writeFileSync(clientHtml, buildClientReport(data));
      hasClient = true;
      try { printPdf(clientHtml, join(data.outDir, "report-client.pdf")); } catch { job.stages.push("(client PDF failed; HTML is fine)"); }
    } catch (e) { job.stages.push("(client report failed: " + (e.message || e) + ")"); }
  } else {
    job.stages.push("(client report not available yet)");
  }
  writeFileSync(join(data.outDir, "outreach.txt"), outreachDraft(data));
  writeFileSync(join(data.outDir, "findings.csv"), findingsCsv(data));
  writeFileSync(join(data.outDir, "pages.csv"), pagesCsv(data));
  archiveRun(data.outDir, data.stamp);
  job.slug = data.slug;
  job.pro = true;
  job.top = data.fixes.map(f => f.title);
  job.scores = { perf: data.lighthouse.ok ? data.lighthouse.perf : null, seo: data.lighthouse.ok ? data.lighthouse.seo : null, ...data.scores };
  job.summary = { pages: data.crawl.pages.length, links: data.crawl.linksChecked,
                  dead: data.links.brokenInternal + data.links.brokenExternal, findings: data.findings.length };
  job.runNotes = data.runNotes || [];
  job.history = data.history ? data.history.diff.summary : null;
  job.compete = competeLine(data.discovery, data.headToHead ? data.headToHead.summary.line : null);
  job.hasClient = hasClient;
  job.stages.push("Done.");
}

async function runBatchJob(job) {
  const { rows, maxPages, type, industry, findCompetitors, batchDir, stamp } = job.opts;
  const { results, failures } = await runBatch(rows, { maxPages, type, industry, findCompetitors, batchDir, log: s => job.stages.push(s) });
  writeFileSync(join(batchDir, "index.html"), batchIndexHtml(results, failures));
  job.batchDir = batchDir;
  job.url = `/out/_batch/${stamp}/index.html`;
  job.results = results.length;
  job.failures = failures.length;
  job.stages.push("Done.");
}

loadJobs();
pump();

// ---------- share links ----------
// The only way a non-owner ever sees a client report: a random token that maps to
// one slug, revocable at any time. No token, no report.
let shares = {};
try { shares = JSON.parse(readFileSync(SHARES_FILE, "utf8")); } catch { shares = {}; }
function saveShares() { try { mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(SHARES_FILE, JSON.stringify(shares)); } catch {} }

createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/") {
    return send(res, 200, readFileSync(join(ROOT, "ui.html"), "utf8"), "html");
  }
  if (req.method === "POST" && u.pathname === "/run") {
    let body = ""; for await (const c of req) body += c;
    let opts; try { opts = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
    if (!/^https?:\/\//i.test(opts.url || "")) return send(res, 400, { error: "Paste a full URL starting with http(s)://" });
    if (opts.mode === "pro" && !isOwner(req)) return send(res, 403, { error: "The full audit is owner-only." });
    if (!isOwner(req)) {
      const why = ssrfBlocked(opts.url);
      if (why) return send(res, 400, { error: why });
    }
    // Competitors: up to three full URLs, never the site itself, and for anyone who is not
    // the owner the same address rules as the site. The single field older callers send
    // folds into the list.
    const wanted = [].concat(opts.competitors || [], opts.competitor || []).map(c => String(c || "").trim()).filter(Boolean);
    const seenComp = new Set([opts.url.replace(/\/+$/, "").toLowerCase()]);
    opts.competitors = [];
    delete opts.competitor;
    for (const c of wanted) {
      if (!/^https?:\/\//i.test(c)) return send(res, 400, { error: `Competitor "${c}" needs a full URL starting with http(s)://` });
      if (!isOwner(req)) { const why = ssrfBlocked(c); if (why) return send(res, 400, { error: `Competitor ${c}: ${why}` }); }
      const key = c.replace(/\/+$/, "").toLowerCase();
      if (seenComp.has(key)) continue;
      seenComp.add(key);
      opts.competitors.push(c);
      if (opts.competitors.length === 3) break;
    }
    opts.findCompetitors = opts.findCompetitors === true || opts.findCompetitors === "true" || opts.findCompetitors === 1;
    if (!opts.name) { try { opts.name = new URL(opts.url).hostname.replace(/^www\./, "").split(".")[0].replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()); } catch {} }
    const job = enqueueJob("run", opts);
    return send(res, 200, { id: job.id, position: queue.indexOf(job.id) + 1 });
  }
  if (req.method === "GET" && u.pathname === "/status") {
    const job = jobs.get(u.searchParams.get("id"));
    if (!job) return send(res, 404, { error: "no such job" });
    const out = { ...job };
    if (job.status === "queued") out.position = queue.indexOf(job.id) + 1;
    return send(res, 200, out);
  }
  if (req.method === "GET" && u.pathname === "/api/mode") {
    return send(res, 200, { owner: isOwner(req) });
  }
  if (req.method === "GET" && u.pathname === "/api/checkout/status") {
    return send(res, 200, { enabled: Boolean(process.env.STRIPE_SECRET_KEY) });
  }
  if (req.method === "POST" && u.pathname === "/api/checkout") {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return send(res, 200, { error: "demo mode: payments not connected" });
    let body = ""; for await (const c of req) body += c;
    let opts; try { opts = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
    const slug = opts.slug;
    if (!slug || !/^[a-z0-9-]+$/.test(slug) || !existsSync(join(OUT_DIR, slug))) return send(res, 400, { error: "unknown audit" });
    const origin = "http://" + (req.headers.host || `localhost:${PORT}`);
    const params = {
      mode: "payment",
      success_url: `${origin}/out/${slug}/report.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/out/${slug}/report.html`,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 2900, product_data: { name: "Full SEO Audit Report" } } }],
      metadata: { slug },
    };
    try {
      const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${key}` },
        body: stripeForm(params),
      });
      const session = await r.json();
      if (!r.ok) return send(res, 502, { error: session.error?.message || "Stripe request failed" });
      return send(res, 200, { url: session.url });
    } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
  }
  if (req.method === "GET" && u.pathname === "/api/checkout/verify") {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return send(res, 200, { error: "demo mode: payments not connected" });
    const sessionId = u.searchParams.get("session_id");
    if (!sessionId) return send(res, 400, { error: "missing session_id" });
    try {
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { authorization: `Bearer ${key}` },
      });
      const session = await r.json();
      if (!r.ok) return send(res, 502, { error: session.error?.message || "Stripe request failed" });
      // Scaffold entitlement check: trust the API's payment_status directly. Production TODO:
      // verify via a signed webhook (checkout.session.completed) instead of a client-triggered
      // GET, and persist entitlements — this Set is wiped on every restart.
      if (session.payment_status === "paid" && session.metadata?.slug) {
        paidSlugs.add(session.metadata.slug);
        return send(res, 200, { paid: true, slug: session.metadata.slug });
      }
      return send(res, 200, { paid: false });
    } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
  }
  if (req.method === "GET" && u.pathname === "/recent") {
    const owner = isOwner(req);
    const rows = [];
    if (existsSync(OUT_DIR)) for (const d of readdirSync(OUT_DIR, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith("_")) continue;
      const dir = join(OUT_DIR, d.name);
      // A pro-only run writes audit-pro.json and no audit.json, so list either.
      const f = [join(dir, "audit.json"), join(dir, "audit-pro.json")].find(existsSync);
      if (!f) continue;
      try {
        const a = JSON.parse(readFileSync(f, "utf8"));
        const row = { slug: d.name, name: a.name, date: a.date, url: a.url,
                      hasReport: existsSync(join(dir, "report.html")),
                      hasPro: owner && existsSync(join(dir, "report-pro.html")) };
        if (owner) {
          row.scores = a.scores || null;
          row.findings = (a.findings || []).length;
          row.hasClient = existsSync(join(dir, "report-client.html"));
          row.lastStamp = a.stamp || null;
          let status = null;
          try { status = JSON.parse(readFileSync(join(dir, "client.json"), "utf8")).status || null; } catch {}
          row.status = status;
        }
        rows.push(row);
      } catch {}
    }
    rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return send(res, 200, rows);
  }
  if (req.method === "GET" && u.pathname === "/api/runs") {
    if (!isOwner(req)) return send(res, 403, { error: "owner only" });
    const slug = u.searchParams.get("slug") || "";
    if (!/^[a-z0-9-]+$/.test(slug)) return send(res, 400, { error: "bad slug" });
    return send(res, 200, listRuns(join(OUT_DIR, slug)));
  }
  if (req.method === "GET" && u.pathname === "/api/diff") {
    if (!isOwner(req)) return send(res, 403, { error: "owner only" });
    const slug = u.searchParams.get("slug") || "";
    const a = u.searchParams.get("a") || "";
    const b = u.searchParams.get("b") || "";
    if (!/^[a-z0-9-]+$/.test(slug)) return send(res, 400, { error: "bad slug" });
    if (!/^[\w-]+$/.test(a) || !/^[\w-]+$/.test(b)) return send(res, 400, { error: "bad run id" });
    const fa = safeOutPath([slug, "runs", a, "audit-pro.json"]);
    const fb = safeOutPath([slug, "runs", b, "audit-pro.json"]);
    if (!fa || !fb || !existsSync(fa) || !existsSync(fb)) return send(res, 404, { error: "one of those runs was not found" });
    let dataA, dataB;
    try { dataA = JSON.parse(readFileSync(fa, "utf8")); dataB = JSON.parse(readFileSync(fb, "utf8")); }
    catch { return send(res, 500, { error: "could not read those runs" }); }
    return send(res, 200, diffRuns(dataA, dataB));
  }
  if (req.method === "POST" && u.pathname === "/api/batch") {
    if (!isOwner(req)) return send(res, 403, { error: "owner only" });
    let body = ""; for await (const c of req) body += c;
    let payload; try { payload = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
    const rows = parseCsv(payload.csv || "");
    if (!rows.length) return send(res, 400, { error: "no rows found in that csv" });
    const stamp = new Date().toISOString().slice(0, 16).replace(/:/g, "");
    const batchDir = join(OUT_DIR, "_batch", stamp);
    const job = enqueueJob("batch", { rows, maxPages: payload.maxPages, type: payload.type, industry: payload.industry, findCompetitors: payload.findCompetitors === true, batchDir, stamp });
    return send(res, 200, { id: job.id, position: queue.indexOf(job.id) + 1 });
  }
  if (u.pathname.startsWith("/api/client/") && (req.method === "GET" || req.method === "PUT")) {
    if (!isOwner(req)) return send(res, 403, { error: "owner only" });
    const slug = u.pathname.slice("/api/client/".length);
    if (!/^[a-z0-9-]+$/.test(slug)) return send(res, 400, { error: "bad slug" });
    const file = join(OUT_DIR, slug, "client.json");
    if (req.method === "GET") {
      if (!existsSync(file)) return send(res, 200, {});
      try { return send(res, 200, JSON.parse(readFileSync(file, "utf8"))); }
      catch { return send(res, 500, { error: "client.json for that audit is corrupt" }); }
    }
    let body = ""; for await (const c of req) body += c;
    if (Buffer.byteLength(body, "utf8") > 20 * 1024) return send(res, 400, { error: "that is too big, 20 KB max" });
    let payload; try { payload = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
    if (!existsSync(join(OUT_DIR, slug))) return send(res, 404, { error: "no audit for that slug" });
    writeFileSync(file, JSON.stringify(payload, null, 2));
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && u.pathname === "/api/share") {
    if (!isOwner(req)) return send(res, 403, { error: "owner only" });
    let body = ""; for await (const c of req) body += c;
    let payload; try { payload = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
    const slug = payload.slug;
    if (!slug || !/^[a-z0-9-]+$/.test(slug) || !existsSync(join(OUT_DIR, slug))) return send(res, 400, { error: "unknown audit" });
    const token = randomBytes(12).toString("hex");
    shares[token] = { slug, created: new Date().toISOString() };
    saveShares();
    return send(res, 200, { url: `/s/${token}` });
  }
  if (req.method === "DELETE" && u.pathname.startsWith("/api/share/")) {
    if (!isOwner(req)) return send(res, 403, { error: "owner only" });
    const token = u.pathname.slice("/api/share/".length);
    if (!shares[token]) return send(res, 404, { error: "that link is not active" });
    delete shares[token];
    saveShares();
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && u.pathname.startsWith("/s/")) {
    const rest = u.pathname.slice(3).split("/").filter(Boolean);
    const share = rest[0] && shares[rest[0]];
    if (!share) return send(res, 404, { error: "that link is not active" });
    const wantsPdf = rest[1] === "pdf";
    const file = join(OUT_DIR, share.slug, wantsPdf ? "report-client.pdf" : "report-client.html");
    if (!existsSync(file)) return send(res, 404, { error: "that report is not ready yet" });
    if (wantsPdf) { res.writeHead(200, { "content-type": MIME.pdf }); return res.end(readFileSync(file)); }
    return send(res, 200, readFileSync(file, "utf8"), "html");
  }
  if (req.method === "GET" && u.pathname.startsWith("/out/")) {
    const parts = decodeURIComponent(u.pathname.slice(5)).split("/").filter(Boolean);
    if (!parts.length) return send(res, 404, { error: "not found" });
    const file = safeOutPath(parts);
    if (!file) return send(res, 400, { error: "bad path" });
    const slug = parts[0];
    const filename = parts[parts.length - 1];
    const isRuns = parts[1] === "runs";
    // Every raw Lighthouse file stays with the owner, the per-competitor ones included.
    const isRawLighthouse = /^lighthouse.*\.json$/i.test(filename);
    if ((OWNER_FILES.has(filename) || isRawLighthouse || isRuns) && !isOwner(req)) return send(res, 403, { error: "not found" });
    if (parts.length === 2 && GATED_FILES.has(filename) && !paidSlugs.has(slug)) {
      const teaser = join(OUT_DIR, slug, "report-teaser.html");
      // Audits from before the paywall have no teaser; they keep serving in full.
      if (existsSync(teaser)) {
        if (filename === "report.html") return send(res, 200, readFileSync(teaser, "utf8"), "html");
        return send(res, 402, { error: "Get the full report for $29 to unlock this: open report.html." });
      }
    }
    if (!existsSync(file)) return send(res, 404, { error: "not found" });
    const ext = file.split(".").pop();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    return res.end(readFileSync(file));
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, () => console.log("seo-audit ui on http://localhost:" + PORT));
