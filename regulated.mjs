// Checks for industries whose marketing is regulated: cannabis, hemp and THCA, CBD, alcohol.
// It reads what any visitor can see and flags wording for a person to review. It is not a
// legal opinion and never says a page breaks a law; the report words it the same way.
//   node regulated.mjs --selftest

export function normalizeIndustry(s) {
  const x = String(s || "").toLowerCase().trim();
  if (!x || x === "none") return null;
  if (/hemp|thca|delta[- ]?[89]/.test(x)) return "hemp";
  if (/cannabis|marijuana|weed|dispensar/.test(x)) return "cannabis";
  if (/\bcbd\b/.test(x)) return "cbd";
  if (/alcohol|liquor|wine|beer|spirit|brew|distill/.test(x)) return "alcohol";
  return x;
}
// Industries where visitors are expected to confirm their age before seeing product.
export const AGE_GATED = new Set(["cannabis", "hemp", "alcohol"]);
export const REGULATED = new Set(["cannabis", "hemp", "cbd", "alcohol"]);

// Age-verification plugins, apps and home-grown overlays all leave one of these behind.
// The word boundary matters: "message-popup" contains "age-popup".
const AGE_GATE = /\bage[-_ ]?(?:gate|verif\w*|check\w*|confirm\w*|popup|modal)|\bagechecker|\bagegate|are you (?:over |at least )?(?:21|18|of legal (?:drinking |smoking )?age)|confirm (?:that )?you are (?:21|over 21|of legal age)|must be (?:21|18) (?:or older|and older|years)|verify your age|enter your (?:date of )?birth/i;
export function detectAgeGate(html) {
  const m = String(html || "").match(AGE_GATE);
  return { present: !!m, marker: m ? m[0].slice(0, 60) : null };
}

const STATEMENT_21 = /\b21\s*\+|\b21 (?:and|or) (?:over|older)\b|\b(?:over|at least) (?:the age of )?21\b|\badults? (?:aged? )?21\b|\b21 years (?:of age|and older|or older)\b|\bage 21\b/i;
export const has21Statement = text => STATEMENT_21.test(String(text || ""));

// A promise about a condition, not a word on its own: "cured flower" is a drying process,
// "helps with anxiety" is a claim. The verb and the condition have to sit within a few words.
const CONDITIONS = "anxiety|pain|insomnia|sleep(?:lessness| problems)?|depression|stress|nausea|seizures?|inflammation|cancer|ptsd|arthritis|migraines?|appetite";
const VERBS = "treat(?:s|ing|ment of|ment for)?|cures?|heals?|healing|relieves?|relief (?:from|of|for)|reduces?|eases?|helps? (?:with|you|to)|fights?|prevents?|alleviates?";
const CLAIM = new RegExp(`\\b(?:${VERBS})\\b(?:\\W+\\w+){0,4}?\\W+(?:${CONDITIONS})\\b|\\b(?:${CONDITIONS}) relief\\b|\\bmedicinal (?:benefits?|properties|value)\\b|\\btherapeutic\\b|\\banti-inflammatory\\b`, "gi");
// Money and giveaway wording that cannabis advertising rules single out (Nevada, for one,
// bars offering product for free). On a store's own product pages prices are expected.
// A price, not a business figure: "$35 an eighth" counts, "over $1M of retail sales" does not.
// The lookahead also refuses to stop mid-number, so "$10M" cannot shrink to "$1".
// "Discounts" alone is often a problem being described ("forcing buybacks, discounts and
// damaged brand reputation"), so only the wording of an actual offer counts.
const PROMO = /\$\s?\d[\d,]*(?:\.\d+)?(?![\d,.]|\s?(?:[mkb]|mm|bn|million|billion|thousand)\b)|\b\d{1,2}\s?% (?:off|discount)\b|\bdiscount code\b|\bget a discount\b|\bdiscounted (?:price|rate)s?\b|\bcoupon\b|\bpromo code\b|\bbogo\b|\bbuy one,? get\b|\bfree (?:gift|product|pre-?rolls?|grams?|eighths?|samples?|joints?)\b|\bgiveaway\b/gi;
const PUSH = /\b(?:order|buy|shop) now\b/gi;

// Up to `limit` distinct phrases per pattern, each with a few words of context.
function phrases(text, re, limit = 3) {
  const s = String(text || "");
  const out = [];
  for (const m of s.matchAll(re)) {
    const i = m.index;
    const ctx = s.slice(Math.max(0, i - 30), i + m[0].length + 30).replace(/\s+/g, " ").trim();
    if (!out.some(o => o.toLowerCase().includes(m[0].toLowerCase()))) out.push(ctx);
    if (out.length >= limit) break;
  }
  return out;
}
export function claimPhrases(text) { return phrases(text, CLAIM); }
export function promoPhrases(text) { return [...phrases(text, PROMO), ...phrases(text, PUSH, 2)]; }

const COA = /\bCOAs?\b|certificates? of analysis|lab[- ](?:tests?|results?|reports?|tested)|third[- ]party (?:lab|tested|testing)/i;
export const mentionsLabResults = s => COA.test(String(s || ""));
const WHERE_TO_BUY = /where to (?:buy|find)|find (?:us|a store|a dispensary|a retailer|it|one) near|near you|store locator|dealer locator|find a (?:store|dispensary|retailer|location)|dispensar(?:y|ies) (?:near|that carry)|our retailers|stockists?\b/i;
export const mentionsWhereToBuy = s => WHERE_TO_BUY.test(String(s || ""));

// pages: [{ path, text, links: [{ href, text }] }], homeHtml: the raw homepage.
export function regulatedFacts({ industry, pages = [], homeHtml = "", homeWords = 0 }) {
  const ind = normalizeIndustry(industry);
  if (!ind || !REGULATED.has(ind)) return null;
  const gate = detectAgeGate(homeHtml);
  const allText = pages.map(p => p.text || "").join("\n");
  const linkText = pages.flatMap(p => (p.links || []).map(l => `${l.text || ""} ${l.href || ""}`)).join("\n");
  const claims = pages.map(p => ({ path: p.path, found: claimPhrases(p.text) })).filter(x => x.found.length);
  const promos = pages.map(p => ({ path: p.path, found: promoPhrases(p.text) })).filter(x => x.found.length);
  return {
    industry: ind,
    ageGated: AGE_GATED.has(ind),
    ageGate: gate.present, ageGateMarker: gate.marker,
    // A gate that replaces the page, rather than covering it, leaves crawlers an empty shell.
    ageGateHidesContent: gate.present && homeWords < 40,
    statement21: has21Statement(allText) || has21Statement(homeHtml.replace(/<[^>]+>/g, " ")),
    claims, promos,
    labResults: mentionsLabResults(allText) || mentionsLabResults(linkText),
    whereToBuy: mentionsWhereToBuy(allText) || mentionsWhereToBuy(linkText),
  };
}

// ---------- self-test ----------
if (process.argv.includes("--selftest")) {
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}`); } };
  check("industry: THCA reads as hemp", normalizeIndustry("THCA flower") === "hemp");
  check("industry: weed reads as cannabis", normalizeIndustry("weed brand") === "cannabis");
  check("industry: none is null", normalizeIndustry("none") === null);
  check("age gate found from a plugin class", detectAgeGate('<div class="age-verification-modal">').present);
  check("age gate found from its question", detectAgeGate("<p>Are you 21 or older?</p>").present);
  check("no age gate on a plain page", !detectAgeGate("<p>Our flower is grown indoors.</p>").present);
  check("21+ statement found", has21Statement("For adults 21+ only."));
  check("21 and older found", has21Statement("You must be 21 and older to enter."));
  check("a year is not a 21+ statement", !has21Statement("Founded in 2021 with 12 strains."));
  check("claim: helps with anxiety", claimPhrases("This strain helps with anxiety after work.").length === 1);
  check("claim: pain relief", claimPhrases("Known for pain relief.").length === 1);
  check("not a claim: cured flower", claimPhrases("Cured flower, dried slowly. The cure takes two weeks.").length === 0);
  check("not a claim: treat yourself", claimPhrases("Treat yourself to something new this weekend.").length === 0);
  check("promo: price", promoPhrases("Only $35 an eighth this week").length >= 1);
  check("promo: free pre-roll", promoPhrases("Free pre-roll with every visit").length === 1);
  check("promo: order now", promoPhrases("Order now for Friday").length === 1);
  check("not promo: free of pesticides", promoPhrases("Grown free of pesticides").length === 0);
  check("not promo: a business figure", promoPhrases("Over $1M of Example Brand retail sales and $10M raised").length === 0);
  check("promo: a price with cents", promoPhrases("Now $29.99 for the jar").length === 1);
  check("not promo: discounts named as a problem", promoPhrases("Dried flower sits at retail, forcing buybacks, discounts, and damaged brand reputation.").length === 0);
  check("promo: a percentage discount", promoPhrases("Take 20% off your first order").length === 1);
  check("no age gate from a class that merely ends in -age", !detectAgeGate('<div class="message-popup homepage-check">').present);
  check("lab results via COA", mentionsLabResults("Download the COA for this batch"));
  check("where to buy via locator", mentionsWhereToBuy("Use our store locator"));
  const facts = regulatedFacts({ industry: "cannabis", homeWords: 200, homeHtml: "<div>welcome</div>",
    pages: [{ path: "/", text: "Smooth flower. Relieves stress fast.", links: [{ href: "/find-us", text: "Where to buy" }] }] });
  check("facts: no gate, gated industry", facts.ageGated && !facts.ageGate);
  check("facts: claim listed with its page", facts.claims.length === 1 && facts.claims[0].path === "/");
  check("facts: where to buy from a link", facts.whereToBuy === true);
  check("facts: nothing for an unregulated industry", regulatedFacts({ industry: "roofing" }) === null);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
