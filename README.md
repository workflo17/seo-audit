# SEO Audit · paste a website, get the pitch

Pitch step 1 as a tool: paste a prospect's URL, get back a client-presentable
4-page report AND the 1-page leave-behind, both as PDF. Runs entirely local:
Lighthouse through headless Edge, no API keys.

## The UI (the normal way)

Double-click the **SEO Audit** shortcut on the Desktop, or `Start SEO Audit.cmd` in
this folder. It starts the server, opens the browser, and if the server is already
up it just opens the page. Close the black window to stop it. From a terminal:

```bash
node server.mjs
```

Or `preview_start` name `seo-audit` (:4950, registered in ~/.claude/launch.json).
Open http://localhost:4950 → paste the website → optional fields (business name,
town, the phone Google shows, a competitor URL, rating/reviews) → Run. Takes
about two minutes; Lighthouse is the slow part. Results list stays on the page
under "Recent audits".

Per audit, in `out/<slug>/`:
- `report.pdf` / `report.html` — 4 pages, client-facing: verdict + top-5 fixes,
  speed explained in customer language, per-page crawl table, local presence +
  NAP, trust signals, full prioritized work list.
- `leavebehind.pdf` / `leavebehind.html` — the 1-page version for the table.
- `audit.json` + `lighthouse.json` — raw data.

## The CLI (same pipeline, scriptable)

```bash
node audit.mjs "Example Roofing" https://example-roofing.com --gphone 555-0100 --town "Red Hook, NY" --rating 5.0 --reviews 14
```

## The full audit (mine only)

Everything above is the demo: what a prospect sees, and what the $29 unlock sells.
The full audit is a second, deeper pipeline that only runs for me. See **PRO.md**.

```bash
node pro.mjs "Example Roofing" https://example-roofing.com --pages 60 --town "Red Hook, NY" --gphone 555-0100
```

Or open the UI from this machine and use the black **Owner** panel. It crawls the whole
site instead of five pages, checks every internal link, probes redirects, 404 handling,
security headers, compression and TTFB, runs Lighthouse on mobile *and* desktop, and
writes an 8-page technical report plus a work checklist into `out/<slug>/`. Ten to
fifteen minutes on a real site.

The server refuses `mode: "pro"` and every pro file (`report-pro.*`, `checklist.*`,
`audit-pro.json`, `lighthouse*.json`) to anything that is not loopback or carrying
`OWNER_KEY`; the Owner panel never renders for anyone else.

## What the demo checks

Lighthouse (performance/SEO/a11y/best-practices + LCP/CLS/TBT + top savings
opportunities) · mobile viewport, tap targets, font sizes · titles + meta
descriptions on the homepage AND up to 5 inner pages (duplicates flagged) ·
broken-link sample · tap-to-call links · phone-vs-Google NAP match · LocalBusiness
schema · HTTPS · sitemap/robots · alt-text coverage · analytics presence · stale
copyright year · social preview tags · favicon · competitor keyword gap.
A weighted rules engine ranks everything; top 5 lead both documents.

## Showing it to someone

`showcase.html` in this folder is a standalone explainer page: what the tool does, the
six stages it runs, every check it makes, and the numbers from the recorded test runs.
Open it in a browser, or send the published version.

## Structure

Demo path: `lib.mjs` (crawl + Lighthouse + rules; `BRAND` block for the header identity) ·
`report.mjs` (both documents) · `audit.mjs` (CLI).
Full path: `lib-pro.mjs` (deep crawl + technical probes + link check + 54 rules) ·
`report-pro.mjs` (8-page report + checklist) · `pro.mjs` (CLI).
Shared: `server.mjs` + `ui.html` (:4950) serve both and hold the owner gate.

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
- Windows schannel aborts some transfers after the headers arrive ("missing
  close_notify", wrong-principal certs on www hosts that do not exist). The transport
  probe parses whatever curl printed before it died instead of throwing that answer away.
- PDFs print via headless Edge `--print-to-pdf`.
