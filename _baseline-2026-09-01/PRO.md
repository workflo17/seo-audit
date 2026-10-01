# The full audit · owner-only

Two pipelines live in this folder and they never mix.

| | Demo (`lib.mjs`) | Full (`lib-pro.mjs`) |
|---|---|---|
| Who runs it | anyone who can reach the server | me, from this machine |
| Pages read | homepage + 5 inner pages | whole site, sitemap-seeded, up to 200 |
| Links | 10-link reachability sample | every internal target, plus 60 outbound |
| Lighthouse | mobile | mobile **and** desktop |
| Transport | not checked | TTFB, HTTP version, compression, cache, headers |
| Redirects | not checked | http→https, www/apex, real-404 handling |
| Robots / sitemap | present or absent | parsed, validated, cross-checked against the crawl |
| Rules | 19 | 54, each with evidence and an effort estimate |
| Scoring | Lighthouse numbers | speed / content / technical / local / trust + overall |
| Output | 4-page report, 1-page leave-behind, teaser + $29 unlock | 8-page technical report, work checklist, raw JSON, both Lighthouse files |

The demo is what prospects see and what the paywall sells. The full audit is the
working tool, and nothing public links to it.

## Running it

Browser, from this machine: open http://localhost:4950. The black **Owner** panel
is there, with the full audit already ticked. Set how many pages to crawl, add a
second competitor if you want one, run it.

CLI, same pipeline:

```bash
node pro.mjs "Example Roofing" https://example-roofing.com --pages 60 --town "Red Hook, NY" --gphone 555-0100 --competitor https://rival.com --rating 5.0 --reviews 14
```

Every flag is optional except the URL (`--pages` defaults to 40, capped at 200;
`--competitor` may be repeated up to three times). Output lands in `out/<slug>/`:

- `report-pro.html` / `.pdf`: the 8-page technical report
- `checklist.html` / `.pdf`: one page of what to do, in order, with the effort next to it
- `audit-pro.json`: everything the engine saw
- `lighthouse.json`, `lighthouse-desktop.json`: the raw runs

Budget ten to fifteen minutes on a real site. The two Lighthouse runs are most of it;
the crawl itself waits 120ms between requests per worker on purpose.

## How "owner-only" is enforced

`isOwner(req)` in `server.mjs`:

1. The request comes from loopback (127.0.0.1 / ::1), which is me at this keyboard, and
   it needs no key.
2. Or it carries `x-owner-key` (or `?key=`) matching `OWNER_KEY` from `.env`. With no
   `OWNER_KEY` set, there is no remote owner access at all, which is the default.

Anything else gets `{"owner": false}` from `/api/mode`, a 403 from `POST /run` with
`mode: "pro"`, and a 403 on every pro file: `report-pro.html/.pdf`, `checklist.html/.pdf`,
`audit-pro.json`, `lighthouse*.json`. The UI never renders the Owner panel for them.

Verified on 2026-08-20 by hitting the server over the LAN address instead of localhost:
`/api/mode` returned `{"owner":false}`, the pro run and all pro files returned 403, and
the public demo page still served normally.

If this ever gets exposed past the LAN, set `OWNER_KEY` to a long random string in
`.env` and reach it with `-H "x-owner-key: ..."`. Loopback stays trusted regardless.

## What the full audit checks that the demo does not

**Crawl.** Sitemap-seeded breadth-first over the whole site, robots.txt `Disallow`
honoured, every page mined for title, meta, headings, word count, images and alt text,
canonical, robots meta, schema, phone and tel: links, forms, maps, addresses, hours,
insecure assets, and inbound link count.

**Technical.** http→https redirect, www vs apex unification, whether a missing URL
really returns 404, robots.txt rules in force, sitemap sources and coverage against the
crawl, orphan pages, noindex pages, canonical coverage, mixed content, HSTS,
X-Content-Type-Options, CSP, cache policy, HTTP version, compression, TTFB per page.

**Links.** Every internal target the crawl found but did not fetch, plus up to 60
outbound targets, each requested individually. 401/403/429 are reported separately as
"refused the crawler" rather than counted as broken, because that is usually bot
blocking rather than a dead link.

**Content.** Missing and duplicate titles and descriptions, length distribution, missing
and multiple H1s, thin pages under 300 words, alt-text coverage site-wide, and how many
pages actually name the service area.

**Local.** Every phone number found anywhere on the site (not just the homepage), the
mismatch against what Google shows, tap-to-call coverage per page, address, hours, map,
contact form, LocalBusiness schema, review markup.

**Competitors.** Up to three, compared on word count, schema and the keyword gap against
the whole crawled corpus rather than just the homepage.

## Re-verifying it after a change

`fixture-site.mjs` serves a six-page site on :4951 with defects planted on purpose:
a duplicate title, a page with no meta description, a page with no H1, two H1s on
another, a four-word thin page, a noindexed page, an orphan page that is in the sitemap
but linked from nowhere, an insecure http:// image, a dead internal link and a dead
outbound one, plus a robots.txt and a sitemap.

```bash
node fixture-site.mjs
node pro.mjs "Example Roofing" http://localhost:4951 --pages 20 --town "Astoria, NY" --gphone 718-555-9999
```

Expect health 47/100 (speed 100, content 23, technical 13, local 38, trust 57), 6 pages
crawled, 2 dead links and 24 findings, the three criticals being no HTTPS, the phone
mismatch and the noindexed page. Two consecutive runs give identical numbers, so any
drift means a rule changed behaviour, which is what the fixture is for.

## Scoring

Five category scores plus an overall, weighted speed 25 / content 25 / technical 20 /
local 20 / trust 10. Each category starts at 100 and decays on the weight of its
findings (`100 · e^(−weight/220)`), so a site with eight problems still ranks below one
with three instead of both flooring at zero. Speed is the measured Lighthouse mobile
score whenever Lighthouse ran, never an inferred number.
