// Paste-a-website audit server (:4950). GET / serves the form; POST /run kicks off
// an audit job; GET /status polls it; results live under /out/<slug>/.
// The full report is paywalled behind a $29 Stripe Checkout (test mode until a real
// key is set) — see PAYMENTS.md for how the key plugs in and how checkout works.
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT, runAudit, printPdf } from "./lib.mjs";
import { buildReport, buildLeavebehind, buildReportTeaser } from "./report.mjs";
import { runProAudit } from "./lib-pro.mjs";
import { buildProReport, buildProChecklist } from "./report-pro.mjs";

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

const PORT = 4950;
const jobs = new Map();          // id -> {stages:[], done, error, slug}
const paidSlugs = new Set();     // slug -> unlocked full report (scaffold; see PAYMENTS.md TODOs)
let busy = false;

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
                             "audit-pro.json", "lighthouse.json", "lighthouse-desktop.json"]);

// Owner = same machine (loopback), or an explicit OWNER_KEY header if this ever gets
// exposed beyond localhost. No key in .env means no remote owner access at all.
function isOwner(req) {
  const ra = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (ra === "127.0.0.1" || ra === "::1") return true;
  const key = process.env.OWNER_KEY;
  return Boolean(key) && (req.headers["x-owner-key"] === key || new URL(req.url, "http://x").searchParams.get("key") === key);
}

async function runJob(id, opts) {
  const job = jobs.get(id);
  try {
    if (opts.mode === "pro") return await runProJob(job, opts);
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
    job.done = true;
    job.stages.push("Done.");
  } catch (e) {
    job.error = String(e.message || e);
    job.done = true;
  } finally { busy = false; }
}

// The deep pipeline: no teaser, no paywall, both PDFs, plus the raw Lighthouse files.
async function runProJob(job, opts) {
  const data = await runProAudit(opts, s => job.stages.push(s));
  job.stages.push("Building the full report…");
  const reportHtml = join(data.outDir, "report-pro.html");
  const checkHtml = join(data.outDir, "checklist.html");
  writeFileSync(reportHtml, buildProReport(data));
  writeFileSync(checkHtml, buildProChecklist(data));
  job.stages.push("Printing PDFs…");
  try { printPdf(reportHtml, join(data.outDir, "report-pro.pdf")); } catch { job.stages.push("(report PDF failed; HTML is fine)"); }
  try { printPdf(checkHtml, join(data.outDir, "checklist.pdf")); } catch { job.stages.push("(checklist PDF failed; HTML is fine)"); }
  job.slug = data.slug;
  job.pro = true;
  job.top = data.fixes.map(f => f.title);
  job.scores = { perf: data.lighthouse.ok ? data.lighthouse.perf : null, seo: data.lighthouse.ok ? data.lighthouse.seo : null, ...data.scores };
  job.summary = { pages: data.crawl.pages.length, links: data.crawl.linksChecked,
                  dead: data.links.brokenInternal + data.links.brokenExternal, findings: data.findings.length };
  job.done = true;
  job.stages.push("Done.");
}

createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/") {
    return send(res, 200, readFileSync(join(ROOT, "ui.html"), "utf8"), "html");
  }
  if (req.method === "POST" && u.pathname === "/run") {
    if (busy) return send(res, 429, { error: "An audit is already running — wait for it to finish." });
    let body = ""; for await (const c of req) body += c;
    let opts; try { opts = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
    if (!/^https?:\/\//i.test(opts.url || "")) return send(res, 400, { error: "Paste a full URL starting with http(s)://" });
    if (opts.mode === "pro" && !isOwner(req)) return send(res, 403, { error: "The full audit is owner-only." });
    if (!opts.name) { try { opts.name = new URL(opts.url).hostname.replace(/^www\./, "").split(".")[0].replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()); } catch {} }
    const id = randomUUID();
    jobs.set(id, { stages: ["Starting…"], done: false, error: null, slug: null });
    busy = true;
    runJob(id, opts);
    return send(res, 200, { id });
  }
  if (req.method === "GET" && u.pathname === "/status") {
    const job = jobs.get(u.searchParams.get("id"));
    return job ? send(res, 200, job) : send(res, 404, { error: "no such job" });
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
    if (!slug || !/^[a-z0-9-]+$/.test(slug) || !existsSync(join(ROOT, "out", slug))) return send(res, 400, { error: "unknown audit" });
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
    const outDir = join(ROOT, "out");
    const rows = [];
    if (existsSync(outDir)) for (const d of readdirSync(outDir)) {
      // A pro-only run writes audit-pro.json and no audit.json, so list either.
      const f = [join(outDir, d, "audit.json"), join(outDir, d, "audit-pro.json")].find(existsSync);
      if (!f) continue;
      try {
        const a = JSON.parse(readFileSync(f, "utf8"));
        rows.push({ slug: d, name: a.name, date: a.date, url: a.url,
                    hasReport: existsSync(join(outDir, d, "report.html")),
                    hasPro: isOwner(req) && existsSync(join(outDir, d, "report-pro.html")) });
      } catch {}
    }
    rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return send(res, 200, rows);
  }
  if (req.method === "GET" && u.pathname.startsWith("/out/")) {
    const rel = decodeURIComponent(u.pathname.slice(5)).replace(/\.\./g, "");
    const [slug, filename] = rel.split("/");
    if (OWNER_FILES.has(filename) && !isOwner(req)) return send(res, 403, { error: "not found" });
    if (GATED_FILES.has(filename) && !paidSlugs.has(slug)) {
      const teaser = join(ROOT, "out", slug, "report-teaser.html");
      // Audits from before the paywall have no teaser; they keep serving in full.
      if (existsSync(teaser)) {
        if (filename === "report.html") return send(res, 200, readFileSync(teaser, "utf8"), "html");
        return send(res, 402, { error: "Get the full report for $29 to unlock this: open report.html." });
      }
    }
    const file = join(ROOT, "out", rel);
    if (!existsSync(file)) return send(res, 404, { error: "not found" });
    const ext = file.split(".").pop();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    return res.end(readFileSync(file));
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, () => console.log("seo-audit ui on http://localhost:" + PORT));
