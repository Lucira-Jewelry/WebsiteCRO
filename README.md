# AI CRO Analyst — Lucira Jewelry

Evidence-first conversion-rate analysis for the Lucira Jewelry online storefront. Combines **GA4**, **Microsoft
Clarity**, **Shopify Admin** and **Google Ads** with a **Playwright measurement layer** that drives the live site, so
findings are proven rather than inferred.

A scheduled job adds one day of data each morning and rebuilds an interactive dashboard.

## Start here

Open **[`reports/index.html`](reports/index.html)** — a single hub linking every report below. Every page carries
two nav bars: the top one reaches Insights / Action Plan / Interactive Dashboard / Connectors from anywhere, and a
second row reaches the five page-type breakdowns from anywhere.

**Page-by-page insights** (bifurcated by page type, each with a goal, KPIs, and issues ranked by criticality):

| | What it is |
|---|---|
| **[`reports/page-homepage.html`](reports/page-homepage.html)** | Homepage: the popup problem, the 66% Home→Collection leak. |
| **[`reports/page-plp.html`](reports/page-plp.html)** | Collection pages: the healthiest step, plus the channel-vs-template bounce diagnosis. |
| **[`reports/page-pdp.html`](reports/page-pdp.html)** | Product pages: the ~17s desktop LCP defect, the reviews-placement question, per-product breakdown. |
| **[`reports/page-cart-checkout.html`](reports/page-cart-checkout.html)** | Cart & checkout: the OTP-wall gap, 7.3% vs 30.9% mobile/desktop. |
| **[`reports/page-traffic-ads.html`](reports/page-traffic-ads.html)** | Meta/Paid Social behaviour + a full Google Ads spend/conversion audit. |
| **[`reports/connectors.html`](reports/connectors.html)** | Live health check of every data source (GA4, Clarity, Shopify, Google Ads, GSC, WebEngage, Meta Ads). |

**Full narrative reports:**

| | What it is |
|---|---|
| **[`reports/insights.html`](reports/insights.html)** | The full findings, with screenshots and click heatmaps, plus a running "Update" log. Read this first. |
| **[`reports/action_plan.html`](reports/action_plan.html)** | 21 prioritised tasks across 3 sprints (1 dismissed), each with an owner and a runnable acceptance test. |
| **[`reports/interactive.html`](reports/interactive.html)** | Date-range filterable dashboard with a permanent day-over-day/week-over-week "Pulse" view. |
| **[`tools/DAILY_RUN.md`](tools/DAILY_RUN.md)** | The daily data-refresh procedure. |
| **[`tools/cro-mcp/README.md`](tools/cro-mcp/README.md)** | The Playwright MCP server and its six tools. |

## The headline finding

Playwright added a real ₹44,370 ring to the cart and clicked **Proceed to Checkout** on both breakpoints. On both, the
URL never changed and a **phone + OTP wall appeared with no guest checkout option**.

The gate is identical on mobile and desktop. The experience of it is not:

| | Mobile — 7.3% proceed | Desktop — 30.9% proceed |
|---|---|---|
| Form factor | Full-screen takeover | Centred dialog |
| Cart + total visible | No | **Yes** |
| `CART → SHIPPING → PAYMENT` progress | No | **Yes** |
| Rage clicks (Clarity, 7 days) | 538 | 0 |

On desktop it reads as "log in to continue". On mobile the cart disappears and it reads as *the button broke*. That
difference is the entire 4.2× conversion gap — and the fix is a layout change, not a rebuild.

Every top rage-clicked element on the cart page is a component of that one modal, including `"Cart 1/3"` clicked
**4,654 times**: the header promises three steps, the button refuses to advance, so people start clicking the progress
indicator.

## Repository layout

```
.
├── .mcp.json                     registers the `cro` Playwright MCP server
├── data/
│   ├── daily_device.csv          sessions/bounce/engagement — per day per device
│   ├── daily_funnel.csv          6 funnel events — per day per device
│   ├── daily_clarity.csv         rage/dead clicks + scroll — per day per device
│   ├── metrics_history.csv       weekly series (Mondays only)
│   ├── run_log.csv               ingest audit trail — feeds the freshness banner
│   ├── latest.json               findings, corrections log, tracking issues
│   ├── lab_capture.json          Playwright battery: fold, overlays, vitals
│   └── checkout_gate_*.json      the checkout-gate proof, per device
├── reports/
│   ├── insights.html             full findings (self-contained, images embedded)
│   ├── action_plan.html          the 20-task backlog
│   ├── interactive.html          date-filterable dashboard
│   └── captures/                 3 decisive screenshots (rest are gitignored)
└── tools/
    ├── DAILY_RUN.md              daily procedure
    ├── build_report.ps1          rebuilds interactive.html from the CSVs
    ├── merge_csv.ps1             idempotent CSV append — use this, not Add-Content
    ├── report_template.html      dashboard layout + client-side logic
    ├── insights_template.html    insights layout (images injected at build)
    └── cro-mcp/                  Playwright MCP server + batch scripts
```

## Setup after cloning

```bash
cd tools/cro-mcp && npm install
```

That installs the MCP SDK and Playwright, and downloads Chromium. Restart Claude Code so `.mcp.json` is picked up.

To regenerate the raw captures (gitignored — ~36 MB):

```bash
cd tools/cro-mcp && node capture.js
```

To rebuild the reports after a data change:

```bash
powershell -ExecutionPolicy Bypass -File tools/build_report.ps1
cd tools/cro-mcp && node embed-images.js ../insights_template.html ../../reports/insights.html
```

## Before you present anything — check the banner

`reports/interactive.html` opens with a data-freshness banner. It is the accountability mechanism:

| Banner | Meaning |
|---|---|
| **✓ green** | Complete through T-2. Safe to present. |
| **⚠ amber** | One day behind — a refresh was missed. Usable; say so. |
| **✕ red** | Two or more days stale. **Do not present** until refreshed. |

Underneath it prints the last ingest time and which sources succeeded, read from `data/run_log.csv`. If a run fails,
log it as `failed` — a run recorded `ok` that actually failed is worse than no log, because it silently disables the
staleness warning.

**One reliability gap to know about:** scheduled tasks only run while the app is open. If it's closed at 07:00 the task
runs on next launch, so a dashboard opened cold on a Monday may show amber until catch-up finishes. Treat the banner as
the gate rather than assuming the run happened.

## Scope — what counts as an online order

This is an omnichannel business. Shopify's 211 orders over 30 days are **not** all website conversions. Segment by
`sourceName` before using any order count:

| Segment | `sourceName` | App | Orders (30d) | In scope? | GA4 fires? |
|---|---|---|---|---|---|
| ERP / physical store | `283870494721` | OrnaVerse ERP | 127 | **No** | No |
| Online headless | `307193511937` | Shopify Admin API | 64 | Yes | Yes |
| Salesperson-assisted | `shopify_draft_order` | Draft Orders | 22 | Yes | **No** |

- ERP store orders carry tags prefixed `HO-`, `PV1-`, `PN1-`, `BO1-`, `FCS-`, `N18-` (physical store locations).
- Salesperson-assisted orders **are** online revenue to the business but GA4 cannot see them. Include in revenue;
  exclude from GA4-comparison conversion rates.
- **Shopify native session analytics must be ignored** — the storefront is headless, so it reports ~670 sessions/month
  against ~425,000 in GA4. Expected, not a defect.

## Measurement traps

Four of these have already produced wrong conclusions in this repo's history:

1. **Bounce rate is meaningless on cart / shipping / payment.** It reads 2.8% on mobile cart because users engage
   before abandoning. Use step drop-off.
2. **The interactive dashboard's funnel is event counts, not unique users.** Mobile cart→checkout is 7.9% by users,
   11.2% by events. Both correct, different questions — don't quote them interchangeably.
3. **Clarity LCP *means* are unusable** — desktop mean returned 73,465 ms from a few extreme sessions. Always medians.
   Equally, a **single cold-start lab run** can report a wildly inflated LCP; `cro_vitals` medians across 3 runs.
4. **Blended rates move when traffic mix moves.** Paid Social bounces 62–100% and converts near zero. Check session
   volume before crediting any rate change to a site change.

## Open tracking issues

These distort any ROAS or CVR figure and should be resolved before targets are set.

- **Google Ads over-counts ~7×.** `Begin Checkout`, `Offline Purchase` and `CRM Online Conversion` all count alongside
  `Purchase`, while the correctly wired GA4 import (`Lucira (web) purchase`) is **excluded** from the bidding metric.
  Confirm whether the two `UPLOAD_CLICKS` actions are intentional O2O attribution before changing them.
- **GA4 under-counts ~34%** of trackable online orders. Not diagnosable via API — the `read_pixels` scope isn't
  granted. Check **Shopify Admin → Settings → Customer events**.
- **`begin_checkout` fires after OTP success**, so everyone blocked by the login wall is invisible. Fixing this will
  make the funnel look worse before it looks better; annotate the ship date.

## Corrections log

Findings that later measurement disproved live in `data/latest.json → corrections_log` and are surfaced in the reports.
Five claims have been retracted so far. Keeping them visible is deliberate — it stops a wrong conclusion being carried
forward as an assumption after the reasoning behind it is forgotten.
