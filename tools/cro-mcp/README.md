# cro-mcp — Playwright-backed MCP server for CRO measurement

Exposes CRO-specific browser measurement as MCP tools. The official
[`@playwright/mcp`](https://playwright.dev) gives generic automation (click, type, snapshot); these tools answer CRO
questions directly and return structured numbers rather than DOM dumps, which keeps them cheap to read into an agent's
context.

## Setup

```bash
cd tools/cro-mcp
npm install          # also runs `playwright install chromium`
```

Registered for this repo in [`../../.mcp.json`](../../.mcp.json) as the `cro` server. Restart Claude Code after a fresh
clone so the server is picked up.

## Tools

| Tool | Answers | Key params |
|---|---|---|
| `cro_screenshot` | What does this page look like at this breakpoint, after popups fire? | `url`, `device`, `fullPage`, `settleMs` |
| `cro_fold_analysis` | Where does each CRO element sit, and does the median visitor reach it? | `url`, `device`, `avgScrollDepthPct`, `labels` |
| `cro_heatmap` | Where did the clicks land, on the real rendered page? | `url`, `clicks[{text,count,label}]`, `avgScrollDepthPct` |
| `cro_overlay_audit` | What covers the page, and does it intercept clicks? | `url`, `device`, `settleMs` |
| `cro_vitals` | Real LCP / CLS / FCP / TTFB from a live navigation. | `url`, `device`, `runs` |
| `cro_funnel_walk` | Can a real user actually complete the funnel? | `startUrl`, `cartUrl`, `device` |

`device` is `mobile` (375×812 @2x, iPhone UA), `tablet` (768×1024) or `desktop` (1440×900).

### Two design notes

**`settleMs` matters.** Conditionally-triggered overlays — spin-wheels, login modals — appear seconds after `load`.
Waiting only for `networkidle` misses them entirely, which is how they stay invisible in most audits. Default is
6–8 s.

**`cro_heatmap` bridges a real gap.** Clarity's API returns click counts keyed by element *text*, not coordinates, so
it cannot produce a heatmap image. This tool resolves each text to its live bounding box via Playwright and paints the
counts there, intensity-scaled against the busiest element on the page. Pass `avgScrollDepthPct` to draw the
"average visitor stops here" line.

## Batch scripts

Run directly with `node`; they don't need the MCP layer.

| Script | Purpose |
|---|---|
| `capture.js` | Full battery across home / PLP / PDP / cart × mobile + desktop → `data/lab_capture.json` + `reports/captures/` |
| `funnel.js <device>` | Collection → product → add to cart → cart, with modal-dismissal attempts |
| `checkout-gate.js <device>` | Adds a real item and clicks checkout — this is what proved the OTP wall |
| `embed-images.js <template> <output>` | Downscales captures to JPEG data URIs and injects them into a report template |
| `smoke.js <url> <device>` | Quick single-page fold + overlay + vitals check |

## Known limits

- **Single-run vitals are noisy.** `cro_vitals` medians across `runs` (default 3) for this reason; `capture.js` does
  not, so treat its LCP figures as indicative. A cold first navigation can report a wildly inflated LCP.
- **The overlay detector false-positives on tall content sections.** Any `coverage_pct` above 100 is almost certainly
  a long content block, not an overlay — verify against the screenshot.
- **Text-based element matching fails on graphics.** An element rendered as an image with no text node cannot be
  located, so it will be missing from heatmaps even if heavily clicked.
- **Lab ≠ field.** One machine, one network, one moment. Good for proving a defect is reproducible; not a description
  of the real-user distribution. Clarity remains the field source.

## Implementation

Built on the MCP SDK's low-level `Server` API rather than the higher-level `McpServer`, because that surface has been
stable across SDK versions — a minor bump won't break it.

```
index.js              tool definitions + dispatch
lib/browser.js        Chromium lifecycle, device profiles, settle logic
lib/measure.js        in-page fold analysis, overlay audit, vitals, text location
lib/heatmap.js        heatmap overlay rendering
```
