# The full audit · owner-only

Two pipelines live in this folder and they never mix.

| | Demo (`lib.mjs`) | Full (`lib-pro.mjs`) |
|---|---|---|
| Who runs it | anyone who can reach the server | me, from this machine |
| Pages read | homepage + 5 inner pages | whole site, sitemap-seeded, up to 200 |
| JavaScript sites | not handled | empty shells re-read through headless Edge |
| Links | 10-link reachability sample | every internal target, 60 outbound, every image |
| Lighthouse | mobile | mobile, desktop, and the top inner pages |
| Transport | not checked | TTFB, HTTP version, compression, cache, headers, certificate |
| Redirects | not checked | http to https, www vs apex, chains, real-404 handling |
| Robots / sitemap | present or absent | parsed with Googlebot precedence, validated against the crawl |
| Structured data | is a type present | parsed, field-by-field completeness, phone cross-check |
| Content | titles, metas, H1s | plus duplicates, readability, placeholders, stuffing, CTA, anchors |
| Rules | 20 | 106, each with evidence and an effort estimate |
| Competitors | up to three, homepage checks + Lighthouse each, head-to-head page | the same, plus server response and compression in the rows |
| Scoring | Lighthouse numbers | five categories, unmeasured ones left unscored |
| History | none | every run archived, next run reports what changed |
| Output | 4-page report, 1-page leave-behind, teaser + $29 unlock | 8-page owner report, 6-page client report, checklist, outreach draft, two CSVs, raw JSON |

The demo is what prospects see and what the paywall sells. The full audit is the
working tool, and nothing public links to it.

## Running it

Browser, from this machine: open http://localhost:4950. The black **Owner** panel is
there, with the full audit already ticked. Pick the site type, set how many pages to
crawl and how many inner pages to measure, add competitors, run it.

CLI, same pipeline:

```bash
node pro.mjs "Example Roofing" https://example-roofing.com --pages 60 --town "Red Hook, NY" --gphone 555-0100 --competitor https://rival.com --rating 5.0 --reviews 14
```

Flags: `--pages` (default 40, capped at 200), `--type local|brand|store|b2b|general`,
`--industry cannabis|hemp|cbd|alcohol`, `--lh-pages 0..5` (inner pages to measure with
Lighthouse, default 2), `--lh-runs 1..5` (mobile homepage runs, default 3, the middle score
is used), `--competitor URL` (repeatable, up to three), `--find-competitors`
(search for the rest of the three, see `discover.mjs`), `--gphone`, `--town`, `--rating`,
`--reviews`, `--no-render` (skip the browser fallback for JavaScript sites).

Site types. `local` is a business that serves a place, and the only type that runs and
scores the local-presence rules. `brand` sells a product through other people's stores,
`store` sells online, `b2b` sells to businesses, `general` is anything else. The type
decides what counts as the first-screen button (call or quote for local, where to buy for
a brand, shop for a store, a conversation for B2B) and how the fixes are worded: "service
plus town" titles and "add the price range" are local advice, and they now stay local.

Industry. `cannabis`, `hemp` (THCA and delta-8 count as hemp), `cbd` and `alcohol` add the
regulated-marketing checks in `regulated.mjs`: an age gate on the homepage (not asked of a
B2B site, which addresses businesses) and whether it hides the content from crawlers, a
21+ statement, health or medical wording and price or
giveaway wording flagged for a person to review (never called a violation), lab results
(COAs) for a store, and a store locator for a brand. The industry also keeps the competitor
search inside the industry.

A whole prospect list at once:

```bash
node batch.mjs prospects.csv --pages 30
```

The CSV takes a header row of `name,url,town,gphone,competitor,rating,reviews,type,industry`, and
only `url` is required. The `competitor` cell takes up to three URLs separated by
semicolons, and `--find-competitors` searches for the rest on every row. Sites are audited one at a time because Lighthouse tolerates only
one browser, so budget about ten minutes each and leave it running. The batch writes
`out/_batch/<stamp>/index.html`, a table ranked by opportunity (lowest health first) with
links into each report, plus `summary.csv` and `failures.json`.

Output per site, in `out/<slug>/`:

- `report-pro.html` / `.pdf`: the 8-page technical report, my copy
- `report-client.html` / `.pdf`: the same evidence without the internal appendices, safe to hand over
- `checklist.html` / `.pdf`: one page of what to do, in order, with hours per bucket
- `outreach.txt`: a paste-ready email draft. Nothing is ever sent by this software
- `findings.csv`, `pages.csv`: for a spreadsheet
- `audit-pro.json`: everything the engine saw
- `lighthouse*.json`: the raw runs
- `runs/<stamp>/`: an archive of this run, kept 24 deep

## How "owner-only" is enforced

`isOwner(req)` in `server.mjs`:

1. The request comes from loopback (127.0.0.1 / ::1), which is me at this keyboard, and
   it needs no key.
2. Or it carries `x-owner-key` (or `?key=`) matching `OWNER_KEY` from `.env`. With no
   `OWNER_KEY` set, there is no remote owner access at all, which is the default.

Anything else gets `{"owner": false}` from `/api/mode`, a 403 from `POST /run` with
`mode: "pro"`, and a 403 on every pro file: both reports, the checklist, the outreach
draft, both CSVs, the JSON, the Lighthouse files, and the whole `runs/` archive. The UI
never renders the Owner panel for them.

The one exception is a share link. `POST /api/share {slug}` mints a random 24-character
token; `/s/<token>` then serves that site's **client** report to anyone who has the link,
and `/s/<token>/pdf` the PDF. The owner report is never reachable this way. Tokens live in
`out/_shares.json` and are revoked with `DELETE /api/share/<token>`.

The server also refuses to fetch a private address for anyone but me: localhost, the
RFC1918 ranges, link-local, and `.local` or `.internal` names all return a plain 400.
Without that, a stranger could use this server to scan the network it sits on.

Verified on 2026-09-02 from the LAN address instead of localhost: `/api/mode` returned
`{"owner":false}`, both reports and every generated file returned 403, a minted share link
returned the 6-page client report and its PDF with no owner marks on it, and the public
demo page still served normally.

## What the full audit checks

**Crawl.** Sitemap-seeded breadth-first over the whole site, robots.txt honoured with
Googlebot's own group taking precedence over `*`, and `Allow` beating `Disallow` by
specificity. Click depth from the homepage is recorded for every page. URLs are keyed so
that trailing slashes, `index.html`, capitalisation, `www` and tracking parameters do not
create phantom duplicates. Redirects off the host are noted, not mined. A page that
arrives with almost no words but carries a script is fetched again through headless Edge,
because a JavaScript site is not an empty site. The crawl stops at a wall-clock budget and
says so rather than running all night.

**Technical.** http to https, www versus apex, redirect chains longer than one hop,
whether a missing URL really returns 404, robots.txt rules in force, sitemap coverage
against the crawl, dead and non-indexable and off-host sitemap entries, unreadable
`lastmod` dates, orphan pages, canonical tags resolved and compared (off-site canonicals
are a critical finding), `noindex` in the page, in a `googlebot` meta and in the
`X-Robots-Tag` header, mixed content limited to real assets, security headers, and the TLS
certificate's expiry and hostname coverage.

**Indexability.** Every page gets one verdict and one reason, the way Search Console
reports it: indexable and in the sitemap, indexable but missing from it, or excluded with
the specific cause.

**Links.** Every internal target the crawl found but did not fetch, up to 60 outbound
targets, and up to 40 images, each requested individually with one retry before anything
is called dead. 401, 403 and 429 are reported as "refused the crawler" rather than broken.
If the site answers 200 for missing pages, the report says the link check could not work
here instead of printing a false all-clear.

**Content.** Missing and duplicate titles and descriptions, length distribution, missing
and multiple H1s, heading-level skips, thin pages, near-duplicate pages by shingle
similarity, boilerplate ratio, readability grade, keyword stuffing, template placeholder
text, a call to action in the first screen, anchor text quality, alt-text coverage, the
language attribute, and whether the pages actually name the service area.

**Local presence.** Every phone number on the site against the one Google shows and the
one in the schema, tap-to-call coverage, address, hours, map embed versus a mere link,
contact form quality (labels, field count), business schema completeness field by field,
self-serving review markup (a Google policy violation, so the fix is to remove it),
Google Business Profile and review-site links, licensing and insurance mentions, and
booking or quote paths. All of it is skipped for `--type general`.

**Speed.** Mobile and desktop, plus the inner pages the site links to most. From the
Lighthouse JSON: per-image waste with the reason, third-party main-thread cost by entity,
render-blocking files, page weight by type, font count, cache policy, unused code, layout
shift culprits, and the LCP element with its phases. Lighthouse 13 moved most of this out
of the legacy opportunity list and into `-insight` audits, which is why the old report
showed nothing here. The slow-main-content finding names the element in plain words ("an
image (new-banner-bg.jpg)", "a div block with an animation on it") and says which phase
takes the wait (server, finding the file, downloading it, drawing it), and its fix follows
from that phase.

The mobile homepage score is the middle of three Lighthouse runs (`--lh-runs`), because a
single run on this machine swings by 30 points and more: one brand's homepage read 69, 53,
72 and 91 within 30 hours with nothing changed. The middle run's file is the one the report
reads, and a spread over 15 points is printed in the run notes.

Server response is the middle of three readings of the homepage, and a page that reads
slower than 800 ms in the crawl is timed twice more before it counts as slow: on 22
September one 20-second reading of a client's homepage became a finding, and the same server
answered in 0.2 seconds the next day. The HTTP version comes from the TLS handshake (ALPN),
because neither copy of curl on this machine is built with HTTP/2 and both reported every
site as 1.1.

**Competitors.** Up to three, each measured with the same homepage pass as the target so
the head-to-head table compares like with like. The target's own column reuses its main
mobile Lighthouse run, so its speed is one number everywhere in the report. A competitor
that cannot be read is named in the run notes with the reason (a 403 from a crawler block,
no answer) instead of disappearing. The keyword gap lists words at least two competitors use
(or the only competitor uses three times) that appear nowhere on the crawled site, with
each competitor's brand words and page furniture removed; it is one finding, not one per
competitor.

The competitor search (`discover.mjs`) is keyless, and that has a limit. On 23 September
2026, DuckDuckGo answered every automated request with a bot check (HTTP 202), and Bing's
page effectively searched only the first word: "flash frozen cured cannabis" came back as
Adobe Flash and The Flash TV series, and "cured cannabis" as a supplement shop. The search
now keeps the industry's words in the query, leaves the town out for anything but a local
business, and drops every result that never mentions the business's own noun, so it
reports "none about cannabis" instead of picking recipe sites. For a local business it
still works; for a national brand, paste the competitors (or add a search API later).

**Platform.** WordPress (with Yoast, Rank Math or All in One SEO, and Elementor or Divi),
Wix, Shopify, Squarespace and Webflow are read from the page's own markup and headers
(`platform.mjs`). Findings about titles, descriptions, leftovers, redirects, analytics,
images, robots.txt, age gates, Organization markup and scripts then carry a line saying
where that setting lives on the site's platform. On Wix, Squarespace and Shopify, which count
visits themselves, a missing Google tag is reported as "no Google Analytics, only the
platform's own statistics" at a lower weight.

**Leftovers.** Page-builder templates at their builder's addresses (UICore, Elementor,
Divi, Astra, Kadence, GeneratePress, Oxygen, ElementsKit, including query-string forms such
as `/?uicore-tb=home`) and WordPress's Sample Page, Hello world and `/home-2/` copies are one
finding of their own, and are kept out of the page-quality rules, so a footer template with
no viewport is no longer "the homepage does not work on phones".

**AI crawlers and entity.** `aiready.mjs` reads robots.txt for the crawlers that fetch pages
to answer questions and cite them (OAI-SearchBot, ChatGPT-User, PerplexityBot,
Perplexity-User, Claude-SearchBot, Claude-User) and raises a finding when they are blocked;
training crawlers (GPTBot, ClaudeBot, Google-Extended and others) are recorded but left to the
owner. A Crawl-delay that Bing obeys is a finding. For every type except local, the homepage's
Organization markup is checked for existence, for profile links that are blank or point at a
network's front page (theme placeholders), and for a business name that matches neither the
brand nor the domain.

## Scoring

Five categories, weighted speed 25, content 25, technical 20, local 20, trust 10. Each
starts at 100 and decays on the weight of its findings (`100 · e^(−weight/220)`). Speed is
the measured Lighthouse mobile score whenever Lighthouse ran.

A category that could not be measured scores `null`, its weight is shared out across the
others, and the report says why in a note box on page one. That happens when Lighthouse
fails (speed) or when the site is not a local business (local presence). This matters more
than it sounds: a failed Lighthouse run used to leave every speed rule unable to fire, so
the old formula printed **speed 100** for a site nobody had managed to time.

A Lighthouse run that errors still writes a full report with every category null. That is
now detected, retried once, and reported as a failure rather than read as a score of zero.

## Re-verifying it after a change

`fixture-site.mjs` serves a site on :4951 with defects planted on purpose: duplicate and
missing titles, a missing description, a page with no H1, two H1s on another, a thin page,
a near-duplicate pair, placeholder text, `noindex` three different ways (meta, a
`googlebot` meta with reversed attributes, and an HTTP header), an off-site canonical, an
orphan page, a page four clicks deep, a JavaScript-only page whose content and links only
exist after rendering, three broken images, an insecure image, a broken `og:image`, a dead
internal link, a dead outbound link, a two-hop redirect chain, a stacked-group robots.txt
with an `Allow` exception, and a sitemap with CDATA locations, a dead URL, a noindexed
URL, an off-host URL and an invalid date.

```bash
node fixture-site.mjs
node pro.mjs "Fixture Check" http://localhost:4951 --pages 40 --town "Astoria, NY" --gphone 718-555-9999 --rating 4.9 --lh-pages 0
```

Expect health 36/100 (speed 100, content 7, technical 1, local 18, trust 57), 19 pages
crawled, 13 links checked, 2 dead and 45 findings. Two consecutive runs give identical
numbers, so any drift means a rule changed behaviour, which is what the fixture is for.
Use `--lh-pages 0` for the gate: measuring inner pages adds real timings that vary.

Since 23 September 2026 the fixture also serves a footer template at `/?uicore-tb=footer`
(listed in the sitemap, no viewport), a Crawl-delay in the Googlebot/Bingbot group, a
group blocking OAI-SearchBot, and a sign-in link to `/account/login`. The run has to report
the template as one leftover under its full address and not as a page that fails on
phones, raise the crawl-delay and AI-crawler findings, and not count the sign-in link as
dead. The fixture is served over plain http, so no HTTP-version finding is expected: the
version is read from the TLS handshake, and without one there is no evidence either way.
The code before that date gives 43 findings on the old fixture and 42 on this one.

`SOFT404=1 node fixture-site.mjs` serves the same site with unknown paths answering 200,
which is how a real site hides its dead links. The audit should then find no dead
internal links, **carry the note** explaining that the count is not reliable, and still
report the one dead outbound link (a domain that does not resolve cannot hide behind a
200): health 35/100, 22 pages, 12 links checked, 1 dead, 44 findings.

Every module ships its own self-test:

```bash
for m in render schema lhdetail history batch textstats tlscheck compete discover platform regulated aiready; do node $m.mjs --selftest; done
```

## The modules

The engine is still `lib-pro.mjs`, but the parts that are useful on their own now live
beside it, each with an exported contract and a self-test:

- `render.mjs`: one page through headless Edge, for JavaScript sites
- `schema.mjs`: structured data parsed properly, including completeness and policy checks
- `lhdetail.mjs`: everything actionable inside a Lighthouse 13 report, including screenshots
- `history.mjs`: archive a run, list runs, diff two runs, and find the last run of the
  same host when the folder name (the business name) changed
- `textstats.mjs`: readability, duplication, stuffing, placeholders, anchors, headings
- `tlscheck.mjs`: certificate expiry and hostname coverage, and the HTTP version the TLS
  handshake agrees (ALPN), which is the only HTTP/2 check that works on this machine
- `platform.mjs`: which site builder and SEO plugin a page comes from, and where each kind
  of fix is made on it
- `regulated.mjs`: age gate, 21+ statement, claim and promotion wording, lab results and
  store locator checks for cannabis, hemp, CBD and alcohol
- `aiready.mjs`: which AI crawlers robots.txt lets in, answer crawlers and training
  crawlers kept apart
- `batch.mjs`: the CSV runner, the outreach draft, the CSV exports and the batch index
