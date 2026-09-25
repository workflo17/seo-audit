# SEO Audit · paste a website, get the pitch

Pitch step 1 as a tool: paste a prospect's URL, get back a client-presentable
4-page report AND the 1-page leave-behind, both as PDF. Runs entirely local:
Lighthouse through headless Edge, no API keys. Behind it sits a much deeper
owner-only audit: see PRO.md.

## The UI (the normal way)

Double-click the **SEO Audit** shortcut on the Desktop, or `Start SEO Audit.cmd` in
this folder. It starts the server, opens the browser, and if the server is already
up it just opens the page. Close the black window to stop it. From a terminal:

```bash
node server.mjs
```

Or `preview_start` name `seo-audit` (:4950, registered in ~/.claude/launch.json).
Open http://localhost:4950 → paste the website → optional fields (business name,
town, the phone Google shows, up to three competitor URLs, rating/reviews) → Run. Takes
about two minutes, plus a minute or two per competitor; Lighthouse is the slow part.
"Find competitors for me" is on by default: it searches for what the site says it does
plus the town, and fills the competitor list up to three. Results list stays on the page
under "Recent audits".

Per audit, in `out/<slug>/`:
- `report.pdf` / `report.html`: 4 pages (5 or 6 with competitors), client-facing: verdict +
  top fixes, speed explained in customer language, per-page crawl table, local presence +
  NAP, trust signals, the head-to-head (same checks on every site, best marked, and the
  changes that put this site on top, on a page of their own when there are more than
  three), full prioritized work list.
- `leavebehind.pdf` / `leavebehind.html`: the 1-page version for the table.
- `audit.json` + `lighthouse.json`: raw data.

## The CLI (same pipeline, scriptable)

```bash
node audit.mjs "Example Roofing" https://example-roofing.com --gphone 555-0100 --town "Red Hook, NY" --competitor https://rival.com --find-competitors --rating 5.0 --reviews 14
```

`--competitor` repeats, up to three. `--find-competitors` fills whatever is left of the three
by searching. To see what a search would turn up without running an audit:

```bash
node discover.mjs --live https://example-roofing.com "Example Roofing" "Red Hook, NY"
```

## The full audit (mine only)

Everything above is the demo: what a prospect sees, and what the $29 unlock sells.
The full audit is a second, deeper pipeline that only runs for me. See **PRO.md**.

```bash
node pro.mjs "Example Roofing" https://example-roofing.com --pages 60 --town "Red Hook, NY" --gphone 555-0100
node pro.mjs "Example Brand" https://example-brand.com --type brand --industry cannabis --find-competitors
```

`--type` is local (the default), brand, store, b2b or general, and decides which rules run
and how the fixes are worded. `--industry` (cannabis, hemp, cbd, alcohol) adds the age-gate,
21+, claim-wording, lab-result and store-locator checks. Both are also CSV columns in a batch
and choices in the Owner panel. The platform (WordPress with its SEO plugin, Wix, Shopify,
Squarespace, Webflow) is detected by itself, and fixes say where the setting lives on it.

Or open the UI from this machine and use the black **Owner** panel. It crawls the whole
site instead of five pages, renders JavaScript sites through headless Edge, checks every
internal link and image, probes redirects, 404 handling, security headers, compression,
TTFB and the TLS certificate, parses the structured data field by field, measures
Lighthouse on mobile, desktop and the top inner pages, and writes an 8-page technical
report, a client-safe version of it, a work checklist, an outreach draft and two CSVs
into `out/<slug>/`. Ten to fifteen minutes on a real site.

A whole prospect list in one go:

```bash
node batch.mjs prospects.csv --pages 30
```

Every run is archived under `out/<slug>/runs/`, so the next audit of the same site opens
with what changed since the last one. The folder is named after the business; when it has
no earlier run, the last run of the same host under any other name is used.

The server refuses `mode: "pro"` and every generated file to anything that is not loopback
or carrying `OWNER_KEY`, and the Owner panel never renders for anyone else. The one way to
show a client their report is a share link (`POST /api/share`), which serves the
client-safe version at `/s/<token>` and never the owner copy.

## What the demo checks

Lighthouse (performance/SEO/a11y/best-practices + LCP/CLS/TBT + top savings
opportunities) · mobile viewport, tap targets, font sizes · titles + meta
descriptions on the homepage AND up to 5 inner pages (duplicates flagged) ·
broken-link sample · tap-to-call links · phone-vs-Google NAP match · LocalBusiness
schema · HTTPS · sitemap/robots · alt-text coverage · analytics presence · stale
copyright year · social preview tags · favicon · head-to-head against up to three
competitors (the same homepage checks and a Lighthouse pass on each, the best marked, the
keyword gap, and the list of changes that put this site ahead on every measure).
Competitors come from the form, or from a search when the run asks for it: the two words
that say what the business does (title, headline and description, minus the brand, the town
and the filler) plus "City, ST" (given, or read from the page), sent to DuckDuckGo and Bing's
HTML pages with no API key. Directories, marketplaces, social networks, site builders and
the site itself are dropped, one domain each, homepage only, top three. The report says
which competitors were found and with what query.
A weighted rules engine ranks everything; top 5 lead both documents.

## Showing it to someone

`showcase.html` in this folder is a standalone explainer page: what the tool does, the
six stages it runs, every check it makes, and the numbers from the recorded test runs.
Open it in a browser, or send the published version.

## Structure

Demo path: `lib.mjs` (crawl + Lighthouse + 20 rules; `BRAND` reads from `.env`) ·
`report.mjs` (both documents) · `audit.mjs` (CLI).
Full path: `lib-pro.mjs` (deep crawl, technical probes, link check, 106 rules) ·
`report-pro.mjs` (owner report, client report, checklist) · `pro.mjs` (CLI) ·
`batch.mjs` (CSV runner, outreach draft, CSV exports).
Modules, each with `--selftest`: `render.mjs` (headless Edge for JavaScript sites) ·
`schema.mjs` (structured data) · `lhdetail.mjs` (the actionable parts of a Lighthouse
report) · `history.mjs` (archive and diff runs) · `textstats.mjs` (content quality) ·
`tlscheck.mjs` (certificate) · `compete.mjs` (the head-to-head: both pipelines hand it one
card per site and get back the rows, the gaps and what closes each one) · `discover.mjs`
(finds competitors by search; `--live URL` shows what it would pick) · `platform.mjs` (which
site builder and SEO plugin, and where each fix is made on it) · `regulated.mjs` (age gate,
21+, claim and promotion wording, lab results, store locator) · `aiready.mjs` (which AI
crawlers robots.txt lets in).
Shared: `server.mjs` + `ui.html` (:4950) serve both, hold the owner gate, the job queue
and the share links. `fixture-site.mjs` is the regression harness.

## Machine quirks handled

- Edge relaunches itself when `__COMPAT_LAYER` is set, and processes started from the
  Claude app on this machine inherit `__COMPAT_LAYER=DetectorsAppHealth`. The msedge.exe
  that chrome-launcher starts hands off to its relaunched copy and exits, so the kill at the
  end of a Lighthouse run goes to a process that is already gone. The real browser keeps
  running, and Lighthouse exits 1 because it can't delete the profile that browser still
  holds. `runLighthouse` removes the variable and gives each run its own TEMP folder. After
  the run it ends any msedge.exe whose command line still carries that run's
  `lighthouse.<n>` profile. Success is judged by the report file, never the exit code, since
  a run with a runtime error also writes its report and exits 1.
- Lighthouse is pinned (`LIGHTHOUSE` in `lib.mjs`, 13.4.1 as of September 2026). An
  unpinned `npx lighthouse` picked up 13.5.0, which fails at config time when categories
  are restricted and writes no report at all, so every audit read "unmeasured" until the
  pin went in. Bump it on purpose, after one run against the fixture.
- Fetch falls back to `curl --ssl-no-revoke` (AVG TLS interception).
- Neither curl on this machine (Git's mingw build or Windows' own) is built with HTTP/2, so
  curl reported every site as HTTP/1.1. The HTTP version now comes from the TLS handshake
  (ALPN) in `tlscheck.mjs`, and the full audit raises no HTTP-version finding without one.
- Windows schannel aborts some transfers after the headers arrive ("missing
  close_notify", wrong-principal certs on www hosts that do not exist). The transport
  probe parses whatever curl printed before it died instead of throwing that answer away.
- PDFs print via headless Edge `--print-to-pdf`.
- A Lighthouse run can fail (NO_FCP, navigation error) and still write a full report with
  every category score null. Reading those nulls as zero printed "speed 0/100" for a page
  nobody managed to measure, so a failed run is now detected, retried once, and reported
  as a failure. Nothing unmeasured gets a number.
- An ESM main guard built as `file://${process.argv[1]}` never matches on Windows, where
  `import.meta.url` has three slashes. `pathToFileURL` is the only safe comparison, and
  the symptom is a CLI that exits 0 in silence.
