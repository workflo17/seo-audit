// Pulls the actionable detail out of a raw Lighthouse 13 JSON report that the summary
// numbers throw away. Lighthouse 13 dropped most "opportunity" audits (image, render
// blocking, cache, font, third party, LCP and CLS savings) in favor of "-insight" audits
// that carry a metricSavings object instead of overallSavingsMs/Bytes, so any report
// reader written against Lighthouse 9-12 silently loses that information. This module
// reads both shapes and normalizes them into flat lists the report template can use.
import { readFileSync } from "node:fs";

const num = v => (typeof v === "number" && isFinite(v) ? v : null);
const arr = v => (Array.isArray(v) ? v : []);
const round1 = v => (v === null ? null : Math.round(v * 10) / 10);
const bytesToKb = b => (typeof b === "number" && isFinite(b) ? round1(b / 1024) : 0);

function readJson(p) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(p, "utf8")) };
  } catch (e) {
    return { ok: false, error: String(e.message || e).split("\n")[0].slice(0, 200) };
  }
}

// -------- savings (opportunities + insights, merged) --------
function collectSavings(audits) {
  const out = [];
  for (const [id, audit] of Object.entries(audits || {})) {
    if (!audit) continue;
    const ms = audit.metricSavings;
    if (ms && typeof ms === "object") {
      let bestMetric = null, bestMs = 0;
      for (const [metric, val] of Object.entries(ms)) {
        if (typeof val === "number" && val > bestMs) { bestMs = val; bestMetric = metric; }
      }
      if (bestMetric && bestMs > 0) {
        const kb = bytesToKb(audit.details?.overallSavingsBytes ?? audit.details?.debugData?.wastedBytes);
        out.push({ id, title: audit.title || id, metric: bestMetric, ms: round1(bestMs), kb, items: arr(audit.details?.items) });
      }
      continue;
    }
    if (audit.details?.type === "opportunity" && (audit.details.overallSavingsMs || 0) > 0) {
      out.push({
        id, title: audit.title || id, metric: null, ms: round1(audit.details.overallSavingsMs),
        kb: bytesToKb(audit.details.overallSavingsBytes), items: arr(audit.details.items),
      });
    }
  }
  out.sort((a, b) => (b.ms || 0) - (a.ms || 0) || (b.kb || 0) - (a.kb || 0));
  return out;
}

// -------- images --------
function flattenImageItems(items) {
  const out = [];
  for (const it of arr(items)) {
    const wastedBytes = it.wastedBytes || 0;
    const sub = arr(it.subItems?.items);
    const reason = sub.map(s => s.reason).filter(Boolean).join(", ") || null;
    out.push({ url: it.url || null, kb: bytesToKb(it.totalBytes), wastedKb: bytesToKb(wastedBytes || sub.reduce((s, x) => s + (x.wastedBytes || 0), 0)), reason });
  }
  return out;
}
function collectImages(audits) {
  const insight = flattenImageItems(audits?.["image-delivery-insight"]?.details?.items);
  if (insight.length) return insight.sort((a, b) => b.wastedKb - a.wastedKb);
  const fallbackIds = ["uses-responsive-images", "modern-image-formats", "uses-optimized-images", "offscreen-images"];
  const seen = new Map();
  for (const id of fallbackIds) {
    for (const it of arr(audits?.[id]?.details?.items)) {
      if (!it.url) continue;
      const wastedKb = bytesToKb(it.wastedBytes);
      const prev = seen.get(it.url);
      if (!prev || wastedKb > prev.wastedKb) seen.set(it.url, { url: it.url, kb: bytesToKb(it.totalBytes), wastedKb, reason: id });
    }
  }
  return [...seen.values()].sort((a, b) => b.wastedKb - a.wastedKb);
}

// -------- LCP breakdown --------
function collectLcp(audits) {
  const element = audits?.["largest-contentful-paint-element"]?.details?.items?.[0]?.node?.snippet
    || audits?.["largest-contentful-paint-element"]?.details?.items?.[0]?.node?.nodeLabel || null;
  const lcpUrl = arr(audits?.["largest-contentful-paint-element"]?.details?.items?.[0]?.items).find(i => i.url)?.url || null;
  const phases = { ttfb: null, loadDelay: null, loadDuration: null, renderDelay: null };
  let breakdownElement = null;
  for (const entry of arr(audits?.["lcp-breakdown-insight"]?.details?.items)) {
    if (entry?.type === "node") { breakdownElement = entry.snippet || entry.nodeLabel || breakdownElement; continue; }
    for (const row of arr(entry?.items)) {
      const subpart = row.subpart || row.label || "";
      const val = num(row.duration ?? row.timing ?? row.value);
      if (val === null) continue;
      if (/timeToFirstByte|ttfb/i.test(subpart)) phases.ttfb = round1(val);
      else if (/resourceLoadDelay|loadDelay/i.test(subpart)) phases.loadDelay = round1(val);
      else if (/resourceLoadDuration|loadDuration/i.test(subpart)) phases.loadDuration = round1(val);
      else if (/elementRenderDelay|renderDelay/i.test(subpart)) phases.renderDelay = round1(val);
    }
  }
  return { element: element || breakdownElement || null, url: lcpUrl, phases };
}

// -------- render blocking --------
function collectRenderBlocking(audits) {
  const rows = arr(audits?.["render-blocking-insight"]?.details?.items).length
    ? arr(audits["render-blocking-insight"].details.items)
    : arr(audits?.["render-blocking-resources"]?.details?.items);
  return rows.map(it => ({ url: it.url || null, kb: bytesToKb(it.totalBytes), ms: round1(num(it.wastedMs)) }));
}

// -------- third parties --------
function entityName(e) {
  if (!e) return null;
  if (typeof e === "string") return e;
  return e.text || e.name || null;
}
function collectThirdParties(audits) {
  const rows = arr(audits?.["third-parties-insight"]?.details?.items).length
    ? arr(audits["third-parties-insight"].details.items)
    : arr(audits?.["third-party-summary"]?.details?.items);
  return rows.map(it => ({
    entity: entityName(it.entity) || it.entityName || null,
    kb: bytesToKb(it.transferSize),
    mainThreadMs: round1(num(it.mainThreadTime ?? it.blockingTime)),
  }));
}

// -------- duplicated js --------
function collectDuplicatedJs(audits) {
  return arr(audits?.["duplicated-javascript-insight"]?.details?.items).map(it => ({
    source: it.source || it.value || null, wastedKb: bytesToKb(it.wastedBytes),
  }));
}

// -------- fonts --------
function collectFonts(audits) {
  const netItems = arr(audits?.["network-requests"]?.details?.items).filter(it => it.resourceType === "Font");
  const count = netItems.length;
  const kb = round1(netItems.reduce((s, it) => s + (it.transferSize || 0), 0) / 1024);
  const issues = arr(audits?.["font-display-insight"]?.details?.items).map(it => ({ url: it.url || null, wastedMs: round1(num(it.wastedMs)) }));
  return { count, kb, issues };
}

// -------- cache --------
function collectCache(audits) {
  const rows = arr(audits?.["cache-insight"]?.details?.items).length
    ? arr(audits["cache-insight"].details.items)
    : arr(audits?.["uses-long-cache-ttl"]?.details?.items);
  return rows.map(it => ({
    url: it.url || null, kb: bytesToKb(it.totalBytes),
    ttl: num(it.cacheLifetimeMs) !== null ? round1(it.cacheLifetimeMs / 1000) : num(it.cacheLifetimeMs),
  }));
}

// -------- weight --------
function collectWeight(audits) {
  const items = arr(audits?.["resource-summary"]?.details?.items);
  if (items.length) {
    const total = items.find(i => i.resourceType === "total") || {};
    const byType = { document: 0, script: 0, stylesheet: 0, image: 0, font: 0, media: 0, other: 0 };
    for (const it of items) if (it.resourceType in byType) byType[it.resourceType] = bytesToKb(it.transferSize);
    return { totalKb: bytesToKb(total.transferSize), requests: total.requestCount || 0, byType };
  }
  const net = arr(audits?.["network-requests"]?.details?.items);
  if (net.length) {
    const byType = { document: 0, script: 0, stylesheet: 0, image: 0, font: 0, media: 0, other: 0 };
    let totalBytes = 0;
    const typeMap = { Document: "document", Script: "script", Stylesheet: "stylesheet", Image: "image", Font: "font", Media: "media" };
    for (const it of net) {
      const size = it.transferSize || 0;
      totalBytes += size;
      const key = typeMap[it.resourceType] || "other";
      byType[key] += size;
    }
    for (const k of Object.keys(byType)) byType[k] = bytesToKb(byType[k]);
    return { totalKb: bytesToKb(totalBytes), requests: net.length, byType };
  }
  return { totalKb: 0, requests: 0, byType: { document: 0, script: 0, stylesheet: 0, image: 0, font: 0, media: 0, other: 0 } };
}

// -------- unused code --------
function collectUnusedCode(audits) {
  const out = [];
  for (const it of arr(audits?.["unused-css-rules"]?.details?.items))
    out.push({ url: it.url || null, kb: bytesToKb(it.totalBytes), wastedKb: bytesToKb(it.wastedBytes), kind: "css" });
  for (const it of arr(audits?.["unused-javascript"]?.details?.items))
    out.push({ url: it.url || null, kb: bytesToKb(it.totalBytes), wastedKb: bytesToKb(it.wastedBytes), kind: "js" });
  for (const it of arr(audits?.["legacy-javascript-insight"]?.details?.items))
    out.push({ url: it.url || null, kb: bytesToKb(it.totalBytes), wastedKb: bytesToKb(it.wastedBytes), kind: "legacy-js" });
  return out;
}

// -------- CLS --------
function collectCls(audits) {
  const culprits = [];
  for (const entry of arr(audits?.["cls-culprits-insight"]?.details?.items)) {
    for (const row of arr(entry?.items)) {
      const node = row.node?.nodeLabel || row.node?.snippet || (row.node?.type === "text" ? null : null);
      if (row.node?.type === "text") continue; // skip the "Total" summary row
      culprits.push({ node: node || null, score: num(row.score) });
    }
  }
  const unsizedImages = arr(audits?.["unsized-images"]?.details?.items).map(it => ({
    url: it.url || null, node: it.node?.nodeLabel || it.node?.snippet || null,
  }));
  return { culprits, unsizedImages };
}

// -------- TBT / long tasks --------
function collectTbt(audits) {
  const bootup = audits?.["bootup-time"];
  const bootupMs = num(bootup?.numericValue);
  const topScripts = arr(bootup?.details?.items)
    .filter(it => it.url && it.url !== "Unattributable")
    .map(it => ({ url: it.url, ms: round1(num(it.total)) }))
    .sort((a, b) => (b.ms || 0) - (a.ms || 0))
    .slice(0, 10);
  const longTasks = arr(audits?.["long-tasks"]?.details?.items).length;
  return { bootupMs: round1(bootupMs), longTasks, topScripts };
}

// -------- categories (a11y / seo) --------
function collectCategoryFailures(lh, categoryId) {
  const cat = lh.categories?.[categoryId];
  const audits = lh.audits || {};
  const out = [];
  for (const ref of arr(cat?.auditRefs)) {
    const audit = audits[ref.id];
    if (!audit || audit.score === null || audit.score === undefined || audit.score >= 1) continue;
    const count = arr(audit.details?.items).length;
    out.push({ id: ref.id, title: audit.title || ref.id, count });
  }
  return out;
}

function auditFailed(audits, id) {
  const a = audits?.[id];
  return !!a && a.score !== null && a.score !== undefined && a.score < 1;
}

function collectScreenshots(lh) {
  const audits = lh.audits || {};
  return {
    final: audits["final-screenshot"]?.details?.data || null,
    frames: arr(audits["screenshot-thumbnails"]?.details?.items).map(it => it.data).filter(Boolean),
    fullPage: lh.fullPageScreenshot?.screenshot?.data || null,
  };
}

export function lighthouseDetail(lhJsonPath) {
  const read = readJson(lhJsonPath);
  if (!read.ok) return { ok: false, error: read.error };
  const lh = read.data;
  if (!lh || typeof lh !== "object") return { ok: false, error: "not a lighthouse json object" };
  const audits = lh.audits || {};
  try {
    return {
      ok: true,
      version: lh.lighthouseVersion || null,
      fetchTime: lh.fetchTime || null,
      formFactor: lh.configSettings?.formFactor || lh.configSettings?.emulatedFormFactor || null,
      screenshots: collectScreenshots(lh),
      savings: collectSavings(audits),
      images: collectImages(audits),
      lcp: collectLcp(audits),
      renderBlocking: collectRenderBlocking(audits),
      thirdParties: collectThirdParties(audits),
      duplicatedJs: collectDuplicatedJs(audits),
      fonts: collectFonts(audits),
      cache: collectCache(audits),
      weight: collectWeight(audits),
      unusedCode: collectUnusedCode(audits),
      cls: collectCls(audits),
      tbt: collectTbt(audits),
      a11y: collectCategoryFailures(lh, "accessibility"),
      seo: collectCategoryFailures(lh, "seo"),
      flags: {
        fontSize: auditFailed(audits, "font-size"),
        tapTargets: auditFailed(audits, "tap-targets"),
        viewport: auditFailed(audits, "viewport") || auditFailed(audits, "viewport-insight"),
      },
      domSize: num(audits["dom-size-insight"]?.numericValue ?? audits["dom-size"]?.numericValue),
    };
  } catch (e) {
    return { ok: false, error: "parse failure: " + String(e.message || e).slice(0, 200) };
  }
}

// ---------- self-test ----------
if (process.argv.includes("--selftest")) {
  const path = await import("node:path");
  const results = [];
  const check = (name, cond) => results.push({ name, pass: !!cond });

  const fixDir = "C:/Users/donfl/seo-audit/out/fixture-roofing";
  const mobile = lighthouseDetail(path.join(fixDir, "lighthouse.json"));
  const desktop = lighthouseDetail(path.join(fixDir, "lighthouse-desktop.json"));

  check("mobile report ok", mobile.ok === true);
  check("desktop report ok", desktop.ok === true);
  check("version starts with 13", typeof mobile.version === "string" && mobile.version.startsWith("13"));
  check("screenshots.final is a data:image URI", typeof mobile.screenshots?.final === "string" && mobile.screenshots.final.startsWith("data:image"));
  check("screenshots.frames.length === 8", mobile.screenshots?.frames?.length === 8);
  check("weight.totalKb > 0", mobile.weight?.totalKb > 0);
  check("weight.requests > 0", mobile.weight?.requests > 0);
  check("savings is an array", Array.isArray(mobile.savings));
  check("a11y is a non-empty array", Array.isArray(mobile.a11y) && mobile.a11y.length >= 1);
  check("a11y includes image-alt", mobile.a11y.some(x => x.id === "image-alt"));
  check("flags has three booleans", typeof mobile.flags?.fontSize === "boolean" && typeof mobile.flags?.tapTargets === "boolean" && typeof mobile.flags?.viewport === "boolean");
  check("lcp has phases object", mobile.lcp && typeof mobile.lcp.phases === "object");
  check("missing file returns ok:false", lighthouseDetail("does-not-exist.json").ok === false);
  check("desktop formFactor is desktop", desktop.formFactor === "desktop");

  let failCount = 0;
  for (const r of results) {
    console.log((r.pass ? "PASS" : "FAIL") + " - " + r.name);
    if (!r.pass) failCount++;
  }
  console.log(`\n${results.length - failCount}/${results.length} passed`);
  console.log("\nSummary:");
  console.log("mobile: version=" + mobile.version + " formFactor=" + mobile.formFactor + " weight=" + mobile.weight.totalKb + "kb/" + mobile.weight.requests + "req"
    + " savings=" + mobile.savings.length + " images=" + mobile.images.length + " a11y=" + mobile.a11y.length + " seo=" + mobile.seo.length
    + " domSize=" + mobile.domSize + " lcp.element=" + JSON.stringify(mobile.lcp.element));
  console.log("desktop: version=" + desktop.version + " formFactor=" + desktop.formFactor + " weight=" + desktop.weight.totalKb + "kb/" + desktop.weight.requests + "req");

  if (failCount > 0) process.exit(1);
}
