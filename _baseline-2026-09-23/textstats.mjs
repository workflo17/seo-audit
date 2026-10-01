// Content-quality measurements over crawled text and HTML: readability, keyword
// stuffing, near-duplicate detection (shingle/Jaccard), placeholder text, above-fold
// CTA presence, anchor and heading quality, and title/H1 alignment. Pure functions,
// no I/O, no imports, so lib-pro.mjs's crawl loop can call these per page cheaply.

const WORD_RE = /[A-Za-z0-9']+/g;
const STOPWORDS = new Set(["with", "from", "your", "have", "this", "that", "will",
  "about", "into", "were", "been", "than", "then", "when", "what", "where", "which",
  "there", "here", "such", "also", "only", "just", "more", "most", "some", "each",
  "both", "over", "under", "after", "before", "during", "these", "those", "does"]);

const round1 = n => Math.round(n * 10) / 10;
const round2 = n => Math.round(n * 100) / 100;
const round4 = n => Math.round(n * 10000) / 10000;
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripTags = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// ---------- readability ----------
// Vowel-group heuristic: count vowel runs, drop one for a silent trailing "e" (but not
// "-le", which usually carries its own syllable, e.g. "simple"). Not a dictionary, just
// close enough for a content-quality signal.
function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g) || [];
  let n = groups.length;
  if (w.length > 2 && w.endsWith("e") && !w.endsWith("le")) n--;
  return n > 0 ? n : 1;
}

export function readability(text) {
  const t = String(text || "").trim();
  const wordList = t.match(WORD_RE) || [];
  const words = wordList.length;
  if (!words) return { words: 0, sentences: 0, syllablesPerWord: 0, gradeLevel: 0, readingEase: 0 };
  const sentences = (t.match(/[.!?]+/g) || []).length || 1;
  const syllables = wordList.reduce((sum, w) => sum + countSyllables(w), 0);
  const wordsPerSentence = words / sentences;
  const syllablesPerWord = syllables / words;
  const gradeLevel = round1(0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59);
  const readingEase = Math.max(0, Math.min(100, round1(206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord)));
  return { words, sentences, syllablesPerWord: round2(syllablesPerWord), gradeLevel, readingEase };
}

// ---------- keyword stuffing ----------
export function keywordStuffing(text, terms) {
  const t = String(text || "");
  const total = (t.match(WORD_RE) || []).length;
  const list = (terms || []).map(term => {
    const pattern = escapeRegex(String(term).toLowerCase()).replace(/\s+/g, "\\s+");
    const count = (t.match(new RegExp(`\\b${pattern}\\b`, "gi")) || []).length;
    const densityPct = total ? round2((count / total) * 100) : 0;
    return { term, count, densityPct };
  });
  // Two ways in: a sustained high density, or a raw count that is only possible by
  // repeating the term well past what a short page would naturally need.
  const stuffed = list.some(r => (r.densityPct > 3.0 && r.count >= 5) || (r.count >= 8 && total < 300));
  return { total, terms: list, stuffed };
}

// ---------- near-duplicate content ----------
export function shingles(text, k = 5) {
  const words = String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  const set = new Set();
  for (let i = 0; i + k <= words.length; i++) set.add(words.slice(i, i + k).join(" "));
  return set;
}

export function similarity(setA, setB) {
  if (!setA.size && !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union ? round4(inter / union) : 0;
}

export function nearDuplicates(pages, threshold = 0.6) {
  const list = (pages || []).map(p => ({ path: p.path, set: shingles(p.text, 5) }));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const sim = similarity(list[i].set, list[j].set);
      if (sim >= threshold) out.push({ a: list[i].path, b: list[j].path, similarity: sim });
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity);
}

export function boilerplateRatio(pages) {
  const sets = (pages || []).map(p => shingles(p.text, 5));
  if (sets.length < 3) return 0;
  const freq = new Map();
  for (const set of sets) for (const sh of set) freq.set(sh, (freq.get(sh) || 0) + 1);
  const half = sets.length / 2;
  let sum = 0;
  for (const set of sets) {
    if (!set.size) continue;
    let common = 0;
    for (const sh of set) if (freq.get(sh) >= half) common++;
    sum += common / set.size;
  }
  return round4(sum / sets.length);
}

// ---------- placeholder text ----------
const MARKERS = [
  ["lorem ipsum", /lorem ipsum/i],
  ["coming soon", /coming soon/i],
  ["under construction", /under construction/i],
  ["your text here", /your text here/i],
  ["insert text", /insert text/i],
  ["[company name]", /\[company name\]/i],
  ["[business name]", /\[business name\]/i],
  ["sample text", /sample text/i],
  ["click here to edit", /click here to edit/i],
  ["123 main street", /123 main street/i],
  ["555-555-5555", /555-555-5555/],
  ["000-000-0000", /000-000-0000/],
  ["email@example.com", /email@example\.com/i],
  ["example@", /example@/i],
  ["TODO", /\bTODO\b/],
  ["lorem", /\blorem\b/i],
];

export function placeholderText(text) {
  const t = String(text || "");
  const found = MARKERS.filter(([, re]) => re.test(t)).map(([label]) => label);
  return [...new Set(found)];
}

// ---------- above-fold CTA ----------
const CTA_WORDS = /\b(call|quote|estimate|book|schedule|contact|get started|free)\b/i;

export function ctaAboveFold(html) {
  const noScripts = String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const bodyStart = noScripts.search(/<body/i);
  const slice = noScripts.slice(bodyStart >= 0 ? bodyStart : 0, (bodyStart >= 0 ? bodyStart : 0) + 3500);
  const tel = slice.match(/href=["']tel:([^"']+)["']/i);
  if (tel) return { found: true, kind: "tel", text: tel[1] };
  for (const m of slice.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const label = stripTags(m[2]);
    if (label && CTA_WORDS.test(label)) return { found: true, kind: "text", text: label.slice(0, 80) };
  }
  if (/<form\b/i.test(slice)) return { found: true, kind: "form", text: null };
  return { found: false, kind: null, text: null };
}

// ---------- anchor quality ----------
const GENERIC_ANCHOR = /^(click here|here|read more|learn more|more|link|this)$/i;

export function anchorQuality(anchors) {
  const list = anchors || [];
  let empty = 0, generic = 0;
  const examples = [];
  for (const a of list) {
    const label = String(a.text || a.ariaLabel || a.title || "").trim();
    const isEmpty = label === "";
    const isGeneric = !isEmpty && GENERIC_ANCHOR.test(label);
    if (isEmpty) empty++;
    if (isGeneric) generic++;
    if ((isEmpty || isGeneric) && examples.length < 6) examples.push({ text: a.text || "", href: a.href || "" });
  }
  return { total: list.length, empty, generic, examples };
}

// ---------- heading outline ----------
export function headingOutline(headings) {
  const list = headings || [];
  const h1s = list.filter(h => h.lvl === 1);
  const h1Texts = h1s.map(h => String(h.text || "").trim());
  const dupH1 = h1Texts.length > 1 && new Set(h1Texts).size < h1Texts.length;
  const longH1 = h1s.some(h => String(h.text || "").length > 70);
  let skips = 0, prevLvl = null;
  for (const h of list) {
    if (prevLvl !== null && h.lvl > prevLvl + 1) skips++;
    prevLvl = h.lvl;
  }
  const contentHeadings = list.filter(h => h.lvl >= 2);
  const noH2 = contentHeadings.length > 0 && !contentHeadings.some(h => h.lvl === 2);
  const empty = list.filter(h => String(h.text || "").trim() === "").length;
  return { h1Count: h1s.length, dupH1, longH1, skips, noH2, empty };
}

// ---------- title/H1 alignment ----------
function contentWords(s) {
  return (String(s || "").toLowerCase().match(/[a-z']{4,}/g) || []).filter(w => !STOPWORDS.has(w));
}

export function titleH1Match(title, h1, path) {
  const h1Words = contentWords(h1);
  if (!String(h1 || "").trim() || !h1Words.length) return { overlap: 0, slugOverlap: 0, mismatch: false };
  const titleWords = new Set(contentWords(title));
  const pathWords = new Set((String(path || "").toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOPWORDS.has(w)));
  const overlap = round2(h1Words.filter(w => titleWords.has(w)).length / h1Words.length);
  const slugOverlap = round2(h1Words.filter(w => pathWords.has(w)).length / h1Words.length);
  return { overlap, slugOverlap, mismatch: overlap < 0.25 };
}

// ---------- self-test ----------
if (process.argv.includes("--selftest")) {
  const results = [];
  const check = (name, cond) => results.push({ name, ok: !!cond });

  const r1 = readability("Our roofing team inspected the old shingles last week. We found some water damage near the chimney area. The homeowner will get a new roof installed soon.");
  check("readability grade in 2..9 range", r1.gradeLevel >= 2 && r1.gradeLevel <= 9);
  check("readability zeros on empty text", readability("").words === 0 && readability("").gradeLevel === 0);

  const stuffedText = (Array(12).fill("roofing").join(" ") + " " + Array(88).fill("word").join(" "));
  const ks1 = keywordStuffing(stuffedText, ["roofing"]);
  check("keywordStuffing detects 12x roofing in 100 words", ks1.stuffed === true && ks1.terms[0].count === 12);
  const ks2 = keywordStuffing("roofing is great, roofing helps.", ["roofing"]);
  check("keywordStuffing does not flag 2 occurrences", ks2.stuffed === false && ks2.terms[0].count === 2);

  const sharedPara = "Our licensed roofing contractors provide quality shingle repair and gutter installation services for local homeowners every single day of the year";
  const pageA = { path: "/a", text: sharedPara + " extra unique sentence about siding work in Astoria Queens" };
  const pageB = { path: "/b", text: sharedPara + " extra unique sentence about siding work in Astoria Queen" };
  const pageC = { path: "/c", text: "Completely unrelated content about pizza toppings and cheese blends and delivery times downtown" };
  const dupes = nearDuplicates([pageA, pageB, pageC], 0.6);
  check("nearDuplicates finds the similar pair", dupes.some(d => (d.a === "/a" && d.b === "/b")));
  check("nearDuplicates skips the unrelated page", !dupes.some(d => d.a === "/c" || d.b === "/c"));

  const nav = "call now for a free roofing estimate on your home today before winter arrives";
  const bp = boilerplateRatio([
    { path: "/1", text: nav + " unique content one about shingles" },
    { path: "/2", text: nav + " unique content two about gutters" },
    { path: "/3", text: nav + " unique content three about siding" },
    { path: "/4", text: "totally different unrelated filler text with no shared phrase at all here" },
  ]);
  check("boilerplateRatio is between 0 and 1", bp > 0 && bp < 1);

  const ph = placeholderText("Welcome! Lorem ipsum dolor sit amet. Call us at 555-555-5555 today.");
  check("placeholderText finds Lorem ipsum", ph.includes("lorem ipsum"));
  check("placeholderText finds the fake phone number", ph.includes("555-555-5555"));

  const cta1 = ctaAboveFold('<html><body><div>Welcome</div><a href="tel:+15551234567">Call</a></body></html>');
  check("ctaAboveFold finds tel: link", cta1.found === true && cta1.kind === "tel");
  const filler = "x".repeat(3600);
  const cta2 = ctaAboveFold(`<html><body>${filler}<a href="tel:+15551234567">Call</a></body></html>`);
  check("ctaAboveFold misses a CTA past 3500 chars", cta2.found === false);

  const anchors = [
    { text: "", href: "/a" },
    { text: "Click here", href: "/b" },
    { text: "Learn More", href: "/c" },
    { text: "Roofing Services in Astoria", href: "/d" },
  ];
  const aq = anchorQuality(anchors);
  check("anchorQuality counts 1 empty", aq.empty === 1);
  check("anchorQuality counts 2 generic", aq.generic === 2);

  const headings = [
    { lvl: 1, text: "Roofing Company" },
    { lvl: 3, text: "Our Services" },
    { lvl: 1, text: "Roofing Company" },
  ];
  const ho = headingOutline(headings);
  check("headingOutline detects h1 to h3 skip", ho.skips === 1);
  check("headingOutline detects duplicate H1", ho.dupH1 === true);

  const tm = titleH1Match("Contact", "Roof Repair in Astoria", "/contact");
  check("titleH1Match flags mismatch", tm.mismatch === true);

  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + " - " + r.name);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
}
