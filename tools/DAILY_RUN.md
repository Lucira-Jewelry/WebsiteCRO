# Daily run procedure

Adds one day of data and rebuilds the interactive report. Takes about 5 minutes.
Everything here is idempotent — re-running the same day overwrites rather than duplicates.

**Base path:** `C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO`

---

## Step 0 — Work out the target date

**Target = today − 2 days.** GA4 and Clarity are still backfilling for the most recent
two days, so pulling them produces numbers that quietly change later.

Check what's already loaded before fetching:

```bash
powershell -Command "(Import-Csv 'C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\data\daily_device.csv' | Select-Object -Last 1).date"
```

If the target date is already the last row, there is nothing to add — skip to Step 4 and
report that the data was already current. If more than one day is missing (app was closed
for a while), loop Steps 1–3 once per missing day, oldest first.

---

## Step 1 — GA4: sessions by device

Call `mcp__analytics-mcp__run_report`:

- `property_id`: `properties/478308692`
- `date_ranges`: `[{"start_date":"<TARGET>","end_date":"<TARGET>"}]`
- `dimensions`: `["date","deviceCategory"]`
- `metrics`: `["sessions","totalUsers","bounceRate","userEngagementDuration","screenPageViews"]`

Returns 3 rows. Write them to a fragment, then merge:

```bash
powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\tools\merge_csv.ps1" -Target "C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\data\daily_device.csv" -Fragment "C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\data\_frag.csv" -Keys date,deviceCategory
```

Fragment header must be exactly:
`date,deviceCategory,sessions,totalUsers,bounceRate,userEngagementDuration,screenPageViews`

- `date` in `YYYYMMDD` form (as GA4 returns it) — the build script normalises it.
- `bounceRate` as a **percentage** (GA4 returns a 0–1 fraction; multiply by 100, 2 dp).
- All other metrics rounded to whole numbers.

---

## Step 2 — GA4: funnel events by device

Same tool:

- `dimensions`: `["date","deviceCategory","eventName"]`
- `metrics`: `["eventCount"]`
- `dimension_filter`:
  `{"filter":{"field_name":"eventName","in_list_filter":{"values":["view_item","add_to_cart","begin_checkout","add_shipping_info","add_payment_info","purchase"]}}}`

Returns up to 18 rows. Fragment header: `date,device,event,events`

```bash
powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\tools\merge_csv.ps1" -Target "C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\data\daily_funnel.csv" -Fragment "C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\data\_frag.csv" -Keys date,device,event
```

These are **event counts, not unique users** — one visitor can fire a step twice. The report
labels them as such. Do not mix them with the user-based figures from `run_funnel_report`.

---

## Step 3 — Clarity: behaviour signals

Call `mcp__Microsoft_Clarity__query-analytics-dashboard` with exactly this phrasing:

> `Total rage clicks, dead clicks and average scroll depth by device type on <TARGET>`

Clarity's API **only returns one day at a time** — multi-day breakdowns fail. It also
rate-limits: if several calls run at once most return
`An error occurred while fetching the data.` Call it **once, alone**, and simply retry on
failure. A second attempt usually succeeds.

Map `PC` → `desktop`. Fragment header: `date,device,rage_clicks,dead_clicks,scroll_depth_pct`
with `date` as `YYYY-MM-DD`.

```bash
powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\tools\merge_csv.ps1" -Target "C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\data\daily_clarity.csv" -Fragment "C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\data\_frag.csv" -Keys date,device
```

If Clarity fails twice, skip it and note the gap. GA4 data still builds; the report shows a
partial-coverage warning for any range with missing Clarity days.

---

## Step 3b — Refresh the deep-dive snapshot

The sections below the red divider in the report come from `data/latest.json`. They must be
refreshed too, or the report shows a current funnel above a week-old set of page tables.

Window: **the 7 days ending on TARGET** (so on 2026-07-28 the window is 2026-07-22 → 2026-07-28).

Update these keys in `data/latest.json`. Everything else in the file — `findings`,
`corrections_log`, `tracking_issues`, `commerce_30d`, `fold_analysis` — is **carried forward
unchanged** unless something genuinely changed (see "Carry-forward rules" below).

| Key | Source |
|---|---|
| `run.window`, `run.generated_at`, `run.id` | bump to the new window / next run number |
| `pages_7d.mobile[]`, `.desktop[]` | GA4 `pagePath` × `deviceCategory` — views, users, engagement, bounce |
| `pages_7d.*[].scroll_depth_pct` | Clarity: *"Average scroll depth percentage for the top 12 most visited pages on mobile between X and Y"* |
| `pages_7d.*[].rage_clicks` / `.dead_clicks` | Clarity: *"Top pages by rage clicks for Mobile devices between X and Y"* (and dead clicks) |
| `funnel_7d` | GA4 `run_funnel_report` with `deviceCategory` breakdown — **user-based**, keep separate from event counts |
| `cart_cliff_7d` | cart-page users from GA4 pagePath, `begin_checkout` users from the funnel report |
| `sessions_7d` | GA4 date × device totals |
| `clarity_7d.device_totals` | Clarity by device for the window |
| `clarity_7d.rage_click_by_element_*` | Clarity: *"Most common clicked text for rage clicks between X and Y"* (and again for the cart page) |
| `clarity_7d.javascript_errors` | Clarity: *"Top JavaScript errors by session count between X and Y"* |
| `performance_7d` | Clarity **median** LCP by device and by page; CLS by device |
| `traffic_quality_7d.landing_page_by_channel` | GA4 `landingPage` × `sessionDefaultChannelGroup` |

Then refresh the copy the build reads from:

```bash
powershell -Command "Copy-Item 'C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\data\<TARGET>_run-NNN.json' 'C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\data\latest.json' -Force"
```

**Carry-forward rules — do not silently drop these:**

- `findings[]` — keep every entry and its `id`. Update `status` to `resolved` only when the
  evidence actually shows it fixed. Add new findings with the next free `F` number. Never
  renumber or delete; a disappearing finding looks like it was fixed when it was forgotten.
- `corrections_log[]` — append only. Never remove an entry.
- `fold_analysis` — re-measure only when the PDP template changes. Note the measurement date.
- `commerce_30d` — refresh weekly (Mondays), not daily. Re-segment by `sourceName`.
- `tracking_issues` — keep until genuinely fixed, then set `status: resolved` with the date.

If the snapshot refresh fails or you run short of time, **still complete Step 4**. A current
funnel with a flagged-stale snapshot beats no update at all — just record `snapshot,failed`
in the run log so the report says so.

---

## Step 4 — Rebuild

```bash
powershell -ExecutionPolicy Bypass -File "C:\Users\Admin\Desktop\Tahir\Agents\websiteCRO\tools\build_report.ps1"
```

Writes `reports/interactive.html` plus a dated copy.

**The build prints a HEALTH line. Check it.** It must read `CURRENT`. If it says `LAGGING` or
`STALE`, the ingest did not actually land and the report will show a warning banner instead of
green — go back and find out why rather than leaving it.

Then append one row to `data/run_log.csv` recording what happened. This is the accountability
trail: the report reads the last row and prints it under the health banner, so anyone in a
meeting can see when data last landed and which sources succeeded.

```
run_at,target_date,ga4_device,ga4_funnel,clarity_daily,snapshot,rows_added,notes
2026-07-28 10:04,2026-07-26,ok,ok,ok,ok,45,"Clarity needed one retry."
```

Use `ok` / `failed` / `skipped`. Be accurate — a run logged `ok` that actually failed is worse
than no log, because it defeats the staleness warning.

---

## Step 5 — Report what moved

Compare the **last 7 days against the 7 before that** and report only what is material:

| Metric | Flag when |
|---|---|
| Cart → checkout rate | moved ≥10% relative |
| Add-to-cart rate | moved ≥10% relative |
| Rage clicks per 1,000 sessions | moved ≥20% relative |
| Sessions | moved ≥15% relative |
| Avg scroll depth | moved ≥3 percentage points |
| Purchases | any change (small base) |

Two rules when writing this up:

1. **Check traffic mix before crediting a rate change.** If sessions moved sharply, a
   funnel-rate shift is probably composition, not behaviour. Paid Social bounces at
   62–100% and converts near zero, so its share swinging moves every blended rate.
2. **Purchases are a base of roughly 2–3 per day.** Day-over-day percentage swings on that
   base are noise. Only call a purchase trend over 7 days or more.

Append one row to `data/metrics_history.csv` on **Mondays only** — that file is the weekly
series, and appending daily makes the rolling 7-day windows overlap by 6/7 and look flat.

---

## Cheat sheet

| Thing | Where |
|---|---|
| Report | `reports/interactive.html` |
| Session data | `data/daily_device.csv` |
| Funnel data | `data/daily_funnel.csv` |
| Clarity data | `data/daily_clarity.csv` |
| Weekly series | `data/metrics_history.csv` |
| Findings + corrections | `data/latest.json` |
| Rebuild | `tools/build_report.ps1` |
| Safe CSV append | `tools/merge_csv.ps1` |
| Layout / logic | `tools/report_template.html` |

## Known constraints

- **Clarity: one day per call, rate-limited.** Sequential calls only. History accumulates
  from 2026-07-19 forward; it cannot be backfilled in bulk.
- **GA4 multi-day pulls overflow the context window.** A 60-day × device × event query
  returns ~196k characters. Single-day pulls are small and safe — that is why the daily
  job exists rather than periodic bulk refetches.
- **Never trust a raw Shopify order count.** 60% are ERP/physical-store orders. Segment by
  `sourceName` first — see the README.
- **Shopify native session analytics is meaningless here** (headless storefront). Ignore it.
