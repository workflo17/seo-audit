// Head to head: this site's homepage against the competitors the user pasted.
// Each pipeline builds one card per site with the same keys (below), hands them here, and
// gets back the table rows, the measures this site is behind on, the ones it already leads,
// and the changes that would put it ahead of every competitor on every measure compared.
// Nothing here fetches or measures; cards come from lib.mjs (demo) or lib-pro.mjs (full).
//   node compete.mjs --selftest
//
// Card keys (null or undefined means not measured, and an unmeasured value is never a
// loss or a win): url, ok, lh: { perf, seo, a11y, bp } | null, https, viewport,
// hasLocalSchema, telLink, metaDesc, ogTitle, words, altPct, ttfbMs, compressed, analytics.

export const host = u => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return String(u || ""); } };
const pathOf = u => { try { const p = new URL(u).pathname; return p === "/" ? "/" : p.replace(/\/$/, ""); } catch { return ""; } };
const known = v => v !== null && v !== undefined;
const num = v => known(v) ? String(v) : "-";
const pct = v => known(v) ? v + "%" : "-";
const ms = v => known(v) ? v + " ms" : "-";
const yn = v => known(v) ? (v ? "yes" : "no") : "-";
// A point or two on a Lighthouse score is run-to-run noise, not a lead.
const higherBy = margin => (a, b) => a - b > margin;
const has = (a, b) => a === true && b !== true;
const EFFORT_HOURS = { "15 minutes": 0.25, "30 minutes": 0.5, "1 hour": 1, "2 hours": 2, "half a day": 4, "1 day": 8, "1-2 days": 12, "2+ days": 20 };

// better: how the best cell in a row is picked. beats(a, b): true when a is meaningfully
// ahead of b. w: how much being behind on this measure weighs in the finding. local: only
// compared for a local business. fix(self, best): what closes the gap, both values printed.
export const MEASURES = [
  { key: "perf", label: "Speed on mobile", get: c => c.lh ? c.lh.perf : null, fmt: num, better: "high", beats: higherBy(5), w: 22, effort: "1 day",
    fix: (s, b) => `Get the mobile speed score from ${s} to above ${b}: compress and resize the hero image, and defer the scripts the first paint does not need.` },
  { key: "seo", label: "SEO basics (Lighthouse)", get: c => c.lh ? c.lh.seo : null, fmt: num, better: "high", beats: higherBy(5), w: 12, effort: "2 hours",
    fix: (s, b) => `Lift the Lighthouse SEO score from ${s} past ${b}. It checks titles, descriptions, crawlability and link text, and it lists each failing check.` },
  { key: "a11y", label: "Accessibility", get: c => c.lh ? c.lh.a11y : null, fmt: num, better: "high", beats: higherBy(5), w: 6, effort: "half a day",
    fix: (s, b) => `Bring accessibility from ${s} past ${b}: label the form fields, fix the low-contrast text, describe the images.` },
  { key: "https", label: "Secure (HTTPS)", get: c => c.https, fmt: yn, better: "bool", beats: has, w: 20, effort: "1 hour",
    fix: () => "Install a certificate and force HTTPS site-wide." },
  { key: "viewport", label: "Works on phones", get: c => c.viewport, fmt: yn, better: "bool", beats: has, w: 25, effort: "1-2 days",
    fix: () => "Add the viewport meta tag and rebuild the template mobile-first." },
  { key: "schema", label: "Business schema", get: c => c.hasLocalSchema, fmt: yn, better: "bool", beats: has, w: 12, effort: "2 hours", local: true,
    fix: () => "Add business schema (name, address, phone, hours, service area) so Google reads this business the way it already reads theirs." },
  { key: "tel", label: "Tap-to-call", get: c => c.telLink, fmt: yn, better: "bool", beats: has, w: 12, effort: "1 hour", local: true,
    fix: () => "Wrap every phone number in a tap-to-call link and add a sticky call button on mobile." },
  { key: "meta", label: "Meta description", get: c => c.metaDesc, fmt: yn, better: "bool", beats: has, w: 8, effort: "15 minutes",
    fix: () => "Write a 150-character meta description with the offer and the town in it." },
  { key: "og", label: "Social preview tags", get: c => c.ogTitle, fmt: yn, better: "bool", beats: has, w: 5, effort: "1 hour",
    fix: () => "Add social preview tags: title, description and a real photo." },
  { key: "words", label: "Words on the homepage", get: c => c.words, fmt: num, better: "high", beats: (a, b) => a - b >= 60 && a > b * 1.25, w: 8, effort: "half a day",
    fix: (s, b) => `Grow the homepage from ${s} words to at least ${b}: what you do, where, for whom, and the proof.` },
  { key: "alt", label: "Images described", get: c => c.altPct, fmt: pct, better: "high", beats: higherBy(15), w: 4, effort: "2 hours",
    fix: (s, b) => `Describe the images that have no alt text (${s} described here, ${b} on theirs).` },
  { key: "ttfb", label: "Server response", get: c => c.ttfbMs, fmt: ms, better: "low", beats: (a, b) => b - a > 200 && a < b * 0.6, w: 6, effort: "2 hours",
    fix: (s, b) => `Cut the server response from ${s} to under ${b}: turn on page caching, or move to faster hosting.` },
  { key: "compressed", label: "Compressed delivery", get: c => c.compressed, fmt: yn, better: "bool", beats: has, w: 4, effort: "30 minutes",
    fix: () => "Turn on gzip or brotli compression at the server or the CDN." },
  { key: "analytics", label: "Analytics installed", get: c => c.analytics, fmt: yn, better: "bool", beats: has, w: 3, effort: "1 hour",
    fix: () => "Install Google Analytics (free) and record call and quote clicks as conversions." },
];

export function compare(self, comps, { siteType = "local" } = {}) {
  const live = (comps || []).filter(c => c && c.ok);
  const cards = [self, ...live];
  // A host names each column unless two sites share one (a rival's other page, or the
  // fixture), in which case the path comes along so the columns stay tellable apart.
  const hosts = cards.map(c => host(c && c.url));
  const clash = new Set(hosts.filter((h, i) => hosts.indexOf(h) !== i));
  const nameOf = c => clash.has(host(c.url)) ? host(c.url) + pathOf(c.url) : host(c.url);
  const names = live.map(nameOf);
  const measures = MEASURES.filter(m => !(m.local && siteType !== "local"));
  const rows = [], losses = [], leads = [], ties = [];
  for (const m of measures) {
    const vals = cards.map(c => c && c.ok !== false && known(m.get(c)) ? m.get(c) : null);
    const sv = vals[0];
    const seen = vals.filter(known);
    let bestVal = null;
    if (seen.length) bestVal = m.better === "high" ? Math.max(...seen) : m.better === "low" ? Math.min(...seen) : (seen.includes(true) ? true : null);
    const best = vals.map(v => known(v) && bestVal !== null && v === bestVal);
    const compared = known(sv) && seen.length > 1;
    const ahead = compared ? live.map((c, i) => ({ c, v: vals[i + 1] })).filter(x => known(x.v) && m.beats(x.v, sv)) : [];
    rows.push({ key: m.key, label: m.label, values: vals, text: vals.map(m.fmt), best, compared, ahead: ahead.map(x => nameOf(x.c)) });
    if (!compared) continue;
    if (ahead.length) {
      const top = ahead.reduce((a, b) => (m.better === "low" ? b.v < a.v : b.v > a.v) ? b : a);
      losses.push({ key: m.key, label: m.label, w: m.w, effort: m.effort, self: sv, selfText: m.fmt(sv), best: top.v, bestText: m.fmt(top.v),
        bestHost: nameOf(top.c), behind: ahead.map(x => nameOf(x.c)), fix: m.fix(m.fmt(sv), m.fmt(top.v)) });
    } else if (live.every((c, i) => !known(vals[i + 1]) || m.beats(sv, vals[i + 1]))) {
      leads.push({ key: m.key, label: m.label, selfText: m.fmt(sv) });
    } else {
      ties.push({ key: m.key, label: m.label, selfText: m.fmt(sv) });
    }
  }
  losses.sort((a, b) => b.w - a.w);
  const compared = rows.filter(r => r.compared).length;
  // League table: a point for every compared measure a site is best, or tied for best, on.
  const points = cards.map((_, i) => rows.filter(r => r.compared && r.best[i]).length);
  const rank = [...points].sort((a, b) => b - a).indexOf(points[0]) + 1;
  const hours = Math.round(losses.reduce((a, l) => a + (EFFORT_HOURS[l.effort] ?? 2), 0) * 100) / 100;
  const effort = hours <= 1 ? "1 hour" : hours <= 2 ? "2 hours" : hours <= 4 ? "half a day" : hours <= 8 ? "1 day" : hours <= 16 ? "1-2 days" : "2+ days";
  const summary = { compared, losses: losses.length, leads: leads.length, ties: ties.length, rank, of: cards.length, points, hours, effort, names };
  summary.line = line(summary);
  return { names, rows, losses, leads, ties, summary };
}

const list = names => names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const ordinal = n => n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : n + "th";

function line(s) {
  if (!s.names.length) return "None of the competitors could be read, so there is no head-to-head.";
  if (!s.compared) return `${list(s.names)} could be read but not measured, so there is no head-to-head.`;
  const vs = `Against ${list(s.names)}`;
  if (!s.losses) return `${vs}: ahead or level on all ${s.compared} measures compared, with nothing to close.`;
  return `${vs}: behind on ${s.losses} of ${s.compared} measures, ahead or level on ${s.compared - s.losses}. ` +
    `${plural(s.losses, "change", "changes")} would put this site on top across the board, about ${s.effort} of work.`;
}

// Where the site sits once wins and ties are counted, for the verdict box.
export const standing = s => s.compared && s.of > 1 ? `Counting the measures it wins or ties, this site ranks ${ordinal(s.rank)} of ${s.of}.` : "";

// One finding for the rules engine, so the top-five list and the leave-behind carry the
// competitive position without repeating the rule that already covers each underlying gap.
export function competitiveFinding(cmp) {
  if (!cmp || !cmp.losses.length) return null;
  const s = cmp.summary;
  const who = s.names.length === 1 ? s.names[0] + " is" : "Competitors are";
  return {
    w: Math.min(82, 38 + 7 * s.losses),
    title: `${who} ahead on ${s.losses} of ${s.compared} measures`,
    cost: "A searcher sees these sites in the same results. The one that is faster, safer and clearer gets the call.",
    fix: `Close these first: ${cmp.losses.slice(0, 3).map(l => `${l.label.toLowerCase()} (this site ${l.selfText}, ${l.bestHost} ${l.bestText})`).join("; ")}. The head-to-head page lists every gap with its fix.`,
    effort: s.effort,
    evidence: cmp.losses.map(l => `${l.label}: this site ${l.selfText}, ${l.bestHost} ${l.bestText}`),
  };
}

// Words in the visible copy of a page, for the "words on the homepage" row when the
// pipeline has not already counted them.
export function wordCount(html) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ");
  return (text.match(/[A-Za-z][A-Za-z'’-]{1,}/g) || []).length;
}

// ---------- self-test ----------
if (process.argv.includes("--selftest")) {
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}`); } };
  const self = { url: "https://mine.example", ok: true, lh: { perf: 41, seo: 90, a11y: 80, bp: 70 }, https: true, viewport: true,
    hasLocalSchema: false, telLink: false, metaDesc: true, ogTitle: false, words: 120, altPct: 40, ttfbMs: 900, compressed: false, analytics: true };
  const rival = { url: "https://www.rival.example/", ok: true, lh: { perf: 92, seo: 88, a11y: 95, bp: 70 }, https: true, viewport: true,
    hasLocalSchema: true, telLink: true, metaDesc: false, ogTitle: false, words: 400, altPct: 45, ttfbMs: 200, compressed: true, analytics: false };
  const dead = { url: "https://gone.example", ok: false };
  const keys = a => a.map(x => x.key).sort().join(",");

  const cmp = compare(self, [rival, dead]);
  check("names drop www and skip unreadable sites", cmp.names.length === 1 && cmp.names[0] === "rival.example");
  check("every measure compared", cmp.summary.compared === MEASURES.length);
  check("losses: perf, a11y, schema, tel, words, ttfb, compressed", keys(cmp.losses) === "a11y,compressed,perf,schema,tel,ttfb,words");
  check("losses ordered by weight, speed first", cmp.losses[0].key === "perf");
  check("leads: meta, analytics", keys(cmp.leads) === "analytics,meta");
  check("ties: seo within 5 points, alt within 15, and the shared yes/no rows", keys(cmp.ties) === "alt,https,og,seo,viewport");
  const perf = cmp.rows.find(r => r.key === "perf");
  check("best cell marked on the competitor only", perf.best[0] === false && perf.best[1] === true);
  check("tied best marked on both", cmp.rows.find(r => r.key === "https").best.every(Boolean));
  check("a row nobody wins marks no cell", cmp.rows.find(r => r.key === "og").best.every(b => !b));
  check("self ranked second of two", cmp.summary.rank === 2 && cmp.summary.of === 2);
  check("summary line names the gap", /^Against rival\.example: behind on 7 of 14 measures, ahead or level on 7\./.test(cmp.summary.line));
  check("standing sentence", standing(cmp.summary) === "Counting the measures it wins or ties, this site ranks 2nd of 2.");
  check("fix prints both values", /from 41 to above 92/.test(cmp.losses[0].fix));
  check("row text formats units", cmp.rows.find(r => r.key === "ttfb").text[0] === "900 ms" && cmp.rows.find(r => r.key === "alt").text[1] === "45%");

  const f = competitiveFinding(cmp);
  check("finding names the single competitor", f.title === "rival.example is ahead on 7 of 14 measures");
  check("finding weight scales with losses and caps below critical", f.w === 82);
  check("finding evidence has one line per loss", f.evidence.length === 7 && /^Speed on mobile: this site 41, rival\.example 92$/.test(f.evidence[0]));
  check("finding effort is the summed bucket", f.effort === cmp.summary.effort);
  check("two competitors are named as competitors", /^Competitors are ahead/.test(competitiveFinding(compare(self, [rival, { ...rival, url: "https://other.example" }])).title));
  const best = { ...rival, metaDesc: true, analytics: true };
  check("no finding when nothing is lost", competitiveFinding(compare(best, [self])) === null);
  check("winning line says so", /ahead or level on all 14 measures compared/.test(compare(best, [self]).summary.line));

  const twin = compare(self, [{ ...rival, url: "https://mine.example/services/" }]);
  check("a competitor on the same host is named by its path", twin.names[0] === "mine.example/services" && twin.losses[0].bestHost === "mine.example/services");
  const general = compare(self, [rival], { siteType: "general" });
  check("a general site skips schema and tap-to-call", !general.rows.some(r => r.key === "schema" || r.key === "tel"));
  const noLh = compare({ ...self, lh: null }, [rival]);
  check("unmeasured speed is neither a loss nor a lead", !noLh.rows.find(r => r.key === "perf").compared && !noLh.losses.some(l => l.key === "perf"));
  check("unmeasured demo rows (ttfb null) drop out of the count", compare({ ...self, ttfbMs: null, compressed: null }, [rival]).summary.compared === MEASURES.length - 2);
  check("no readable competitor gives a plain line", /None of the competitors/.test(compare(self, [dead]).summary.line));
  check("wordCount ignores scripts, styles and tags", wordCount("<style>p{}</style><p>Roof repair in Astoria</p><script>var a = 'not words here';</script>") === 4);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
