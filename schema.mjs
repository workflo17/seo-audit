// Structured data parser: reads JSON-LD (and microdata presence) properly instead of
// only checking for an @type string. Feeds the local-business and trust checks in
// lib-pro.mjs with real field-level completeness instead of a yes/no schema flag.
// Zero dependencies, plain regex plus JSON.parse; nothing here throws to the caller.

const LOCAL_SUFFIX = /(Business|Store|Shop|Service|Salon|Contractor|Repair|Agency|Clinic)$/;
const KNOWN_LOCAL = new Set([
  "LocalBusiness", "HomeAndConstructionBusiness", "GeneralContractor", "RoofingContractor",
  "Plumber", "Electrician", "HVACBusiness", "HousePainter", "Locksmith", "MovingCompany",
  "Dentist", "Physician", "MedicalBusiness", "MedicalClinic", "Restaurant", "FoodEstablishment",
  "Bakery", "CafeOrCoffeeShop", "Store", "AutoRepair", "AutoDealer", "LegalService", "Attorney",
  "AccountingService", "FinancialService", "InsuranceAgency", "RealEstateAgent",
  "ProfessionalService", "BeautySalon", "HairSalon", "DaySpa", "NailSalon",
  "HealthAndBeautyBusiness", "ChildCare", "PetStore", "VeterinaryCare", "SportsActivityLocation",
  "ExerciseGym", "LodgingBusiness", "TravelAgency", "DryCleaningOrLaundry", "EmploymentAgency",
  "FloristShop"
]);

function isLocalType(t) {
  return KNOWN_LOCAL.has(t) || LOCAL_SUFFIX.test(t);
}

// Extract every JSON-LD script body from the raw HTML, tolerating a stray trailing
// comma (a common hand-authored mistake) before giving up on that one block.
function scriptBodies(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    out.push(m[1]);
  }
  return out;
}

function stripTrailingCommas(s) {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

function parseBlock(raw) {
  try { return { ok: true, value: JSON.parse(raw) }; } catch {}
  try { return { ok: true, value: JSON.parse(stripTrailingCommas(raw)) }; } catch {}
  return { ok: false };
}

// Flatten one parsed JSON-LD document into the list of objects it actually describes:
// an array at the top, and any @graph array, both unwrap into their member objects.
function flattenDoc(doc) {
  const items = [];
  const visit = node => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node["@graph"])) { node["@graph"].forEach(visit); return; }
    items.push(node);
  };
  visit(doc);
  return items;
}

function typesOf(block) {
  const t = block["@type"];
  if (!t) return [];
  return [].concat(t).filter(x => typeof x === "string");
}

function last10Digits(s) {
  if (!s) return null;
  const digits = String(s).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function addressOf(block) {
  const a = block.address;
  if (!a || typeof a !== "object") return null;
  return {
    streetAddress: a.streetAddress || null,
    addressLocality: a.addressLocality || null,
    addressRegion: a.addressRegion || null,
    postalCode: a.postalCode || null
  };
}

function hasHoursOf(block) {
  return Boolean(block.openingHours || block.openingHoursSpecification);
}

function buildLocalBusiness(block, isLocal) {
  const address = addressOf(block);
  const type = isLocal ? (typesOf(block).find(isLocalType) || typesOf(block)[0] || "LocalBusiness") : "Organization";
  const telephone = block.telephone || null;
  const lb = {
    type,
    name: block.name || null,
    telephone,
    telephoneDigits: last10Digits(telephone),
    address,
    hasGeo: Boolean(block.geo),
    hasHours: hasHoursOf(block),
    url: block.url || null,
    sameAs: [].concat(block.sameAs || []).filter(x => typeof x === "string"),
    hasImage: Boolean(block.image),
    hasPriceRange: Boolean(block.priceRange),
    hasAreaServed: Boolean(block.areaServed),
    missing: []
  };
  if (!lb.name) lb.missing.push("name");
  if (!lb.telephone) lb.missing.push("telephone");
  if (!address || !address.streetAddress) lb.missing.push("address.streetAddress");
  if (!address || !address.addressLocality) lb.missing.push("address.addressLocality");
  if (!address || !address.postalCode) lb.missing.push("address.postalCode");
  if (!lb.hasHours) lb.missing.push("openingHours");
  if (!lb.hasGeo) lb.missing.push("geo");
  if (!lb.url) lb.missing.push("url");
  if (!lb.hasImage) lb.missing.push("image");
  if (lb.sameAs.length === 0) lb.missing.push("sameAs");
  if (!isLocal) lb.missing.push("notLocalBusinessType");
  // Completeness is scored on the 10 core fields above (not notLocalBusinessType, which
  // is a type mismatch flag rather than a missing field on the object itself).
  const coreFields = 10;
  const coreMissing = lb.missing.filter(m => m !== "notLocalBusinessType").length;
  lb.completeness = Math.round(((coreFields - coreMissing) / coreFields) * 100);
  return lb;
}

export function extractSchema(html, pageUrl) {
  const bodies = scriptBodies(html || "");
  const blocks = [];
  let parseErrors = 0;
  for (const raw of bodies) {
    const parsed = parseBlock(raw);
    if (!parsed.ok) { parseErrors++; continue; }
    blocks.push(...flattenDoc(parsed.value));
  }

  const types = [...new Set(blocks.flatMap(typesOf))];
  const microdata = /itemtype=["'][^"']*schema\.org[^"']*["']/i.test(html || "");

  let localBusiness = null;
  const localBlock = blocks.find(b => typesOf(b).some(isLocalType));
  if (localBlock) {
    localBusiness = buildLocalBusiness(localBlock, true);
  } else {
    const orgBlock = blocks.find(b => typesOf(b).includes("Organization"));
    if (orgBlock) localBusiness = buildLocalBusiness(orgBlock, false);
  }

  const hasReviewMarkup = blocks.some(b => typesOf(b).some(t => t === "Review" || t === "AggregateRating")
    || Boolean(b.aggregateRating) || Boolean(b.review));
  // Self-serving review markup: an AggregateRating or Review nested inside (or as) a
  // LocalBusiness/Organization block on the business's own page. Google's guidance is
  // that only third-party review sites may mark up reviews for someone else, so a
  // business self-publishing its own star rating is a finding, not a compliant fix.
  const selfServingReviews = blocks.some(b => {
    const t = typesOf(b);
    const isBizBlock = t.some(isLocalType) || t.includes("Organization");
    if (!isBizBlock) return false;
    if (b.aggregateRating || b.review) return true;
    return false;
  });

  const hasFAQ = types.includes("FAQPage");
  const hasService = types.includes("Service");
  const hasBreadcrumb = types.includes("BreadcrumbList");
  const hasWebSite = types.includes("WebSite");
  const hasOrganization = types.includes("Organization");
  const localTypes = types.filter(isLocalType);

  return {
    blocks, parseErrors, types, microdata, localBusiness, hasReviewMarkup, selfServingReviews,
    hasFAQ, hasService, hasBreadcrumb, hasWebSite, hasOrganization, localTypes
  };
}

// ---------- self-test ----------
if (process.argv.includes("--selftest")) {
  let pass = 0, fail = 0;
  const check = (name, cond) => {
    if (cond) { pass++; console.log(`PASS ${name}`); }
    else { fail++; console.log(`FAIL ${name}`); }
  };

  // 1. complete LocalBusiness with nested address and openingHoursSpecification
  const html1 = `<html><head><script type="application/ld+json">
  {"@context":"https://schema.org","@type":"RoofingContractor","name":"Acme Roofing",
   "telephone":"(555) 123-4567","url":"https://acme.example",
   "address":{"@type":"PostalAddress","streetAddress":"1 Main St","addressLocality":"Springfield","addressRegion":"NY","postalCode":"12345"},
   "geo":{"@type":"GeoCoordinates","latitude":1,"longitude":2},
   "openingHoursSpecification":[{"@type":"OpeningHoursSpecification","dayOfWeek":"Monday","opens":"08:00","closes":"17:00"}],
   "image":"https://acme.example/logo.png","priceRange":"$$","areaServed":"Springfield",
   "sameAs":["https://facebook.com/acme"]}
  </script></head><body></body></html>`;
  const r1 = extractSchema(html1, "https://acme.example");
  check("1 completeness 100", r1.localBusiness && r1.localBusiness.completeness === 100);
  check("1 missing empty", r1.localBusiness && r1.localBusiness.missing.length === 0);
  check("1 telephoneDigits", r1.localBusiness && r1.localBusiness.telephoneDigits === "5551234567");

  // 2. LocalBusiness with only name and telephone
  const html2 = `<script type="application/ld+json">
  {"@type":"LocalBusiness","name":"Bob's Shop","telephone":"555-000-1111"}
  </script>`;
  const r2 = extractSchema(html2, "https://bob.example");
  check("2 missing has streetAddress", r2.localBusiness && r2.localBusiness.missing.includes("address.streetAddress"));
  check("2 missing has openingHours", r2.localBusiness && r2.localBusiness.missing.includes("openingHours"));

  // 3. @graph containing WebSite + Organization + BreadcrumbList
  const html3 = `<script type="application/ld+json">
  {"@context":"https://schema.org","@graph":[
    {"@type":"WebSite","name":"Site"},
    {"@type":"Organization","name":"Org Co"},
    {"@type":"BreadcrumbList","itemListElement":[]}
  ]}
  </script>`;
  const r3 = extractSchema(html3, "https://org.example");
  check("3 hasBreadcrumb true", r3.hasBreadcrumb === true);
  check("3 localBusiness type Organization", r3.localBusiness && r3.localBusiness.type === "Organization");
  check("3 missing notLocalBusinessType", r3.localBusiness && r3.localBusiness.missing.includes("notLocalBusinessType"));

  // 4. malformed JSON in one block, valid in another
  const html4 = `
  <script type="application/ld+json">{"@type":"LocalBusiness","name":"Broken",,}</script>
  <script type="application/ld+json">{"@type":"Plumber","name":"Good Plumber"}</script>
  `;
  const r4 = extractSchema(html4, "https://mix.example");
  check("4 parseErrors 1", r4.parseErrors === 1);
  check("4 types from valid block", r4.types.includes("Plumber") && !r4.types.includes("LocalBusiness"));

  // 5. LocalBusiness with aggregateRating
  const html5 = `<script type="application/ld+json">
  {"@type":"LocalBusiness","name":"Rated Co","telephone":"555-222-3333",
   "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.8","reviewCount":"120"}}
  </script>`;
  const r5 = extractSchema(html5, "https://rated.example");
  check("5 selfServingReviews true", r5.selfServingReviews === true);
  check("5 hasReviewMarkup true", r5.hasReviewMarkup === true);

  // 6. microdata itemtype only, no JSON-LD
  const html6 = `<div itemscope itemtype="https://schema.org/LocalBusiness"><span itemprop="name">X</span></div>`;
  const r6 = extractSchema(html6, "https://micro.example");
  check("6 microdata true", r6.microdata === true);
  check("6 types empty", r6.types.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
