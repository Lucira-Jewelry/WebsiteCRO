/**
 * Full CRO capture battery across the funnel. Writes screenshots + heatmap
 * images to reports/captures/ and a JSON summary to data/lab_capture.json.
 *
 * Clarity truncates clicked text at ~25 chars, so `needle` is a cleaned prefix
 * for matching while `text` keeps Clarity's raw label for reporting.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { openPage, goto, primeLazyContent, closeBrowser } from "./lib/browser.js";
import { foldAnalysis, overlayAudit, collectVitals, locateByText } from "./lib/measure.js";
import { paintHeatmap } from "./lib/heatmap.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CAPS = path.join(ROOT, "reports", "captures");
const SITE = "https://www.lucirajewelry.com";

const PAGES = [
  { key: "home", label: "Homepage", url: `${SITE}/`, scroll: 27.8, clicks: [
      { needle: "Register to Win",        text: "Register to Win a Reward", count: 703, label: "popup" },
      { needle: "REQUEST OTP",            text: "REQUEST OTP",              count: 428, label: "login" },
      { needle: "Spin the Wheel",         text: "Spin the Wheel",           count: 400, label: "popup" },
      { needle: "New user? Register",     text: "New user? Register",        count: 262, label: "login" },
      { needle: "WELCOME TO LUCIRA",      text: "WELCOME TO LUCIRA",         count: 259, label: "login" },
      { needle: "Rings",                  text: "Rings",                    count: 215, label: "nav" },
      { needle: "100% Secured",           text: "100% Secured & Spam Free",  count: 169, label: "login" },
  ] },
  { key: "plp", label: "Collection (PLP)", url: `${SITE}/collections/eterna`, scroll: 27.66, clicks: [
      { needle: "Eterna",                 text: "Eterna",                    count: 3008, label: "nav" },
      { needle: "Register to Win",        text: "Register to Win a Reward",  count: 1618, label: "popup" },
      { needle: "Spin the Wheel",         text: "Spin the Wheel",            count: 915,  label: "popup" },
      { needle: "REQUEST OTP",            text: "REQUEST OTP",               count: 490,  label: "login" },
      { needle: "New user? Register",     text: "New user? Register",         count: 308,  label: "login" },
      { needle: "Extraaa 3% Bank",        text: "Extraaa 3% Bank Discount",  count: 192,  label: "promo" },
  ] },
  { key: "pdp", label: "Product (PDP)", url: `${SITE}/products/corinthian-pave-diamond-mens-ring`, scroll: 18.26, clicks: [
      { needle: "Yellow",                 text: "Yellow (metal variant)",    count: 638, label: "variant" },
      { needle: "MH",                     text: "MH",                        count: 295, label: "variant" },
      { needle: "MQ",                     text: "MQ",                        count: 225, label: "variant" },
      { needle: "Spin the Wheel",         text: "Spin the Wheel",            count: 77,  label: "popup" },
      { needle: "CUSTOMIZE",              text: "CUSTOMIZE",                 count: 55,  label: "variant" },
      { needle: "REQUEST OTP",            text: "REQUEST OTP",               count: 34,  label: "login" },
  ] },
  { key: "cart", label: "Cart", url: `${SITE}/checkout/cart`, scroll: 80.9, clicks: [] },
];

const DEVICES = ["mobile", "desktop"];
const out = { generated_at: new Date().toISOString(), site: SITE, pages: {} };

await mkdir(CAPS, { recursive: true });

for (const device of DEVICES) {
  for (const p of PAGES) {
    const id = `${p.key}-${device}`;
    process.stderr.write(`\n[${id}] `);
    const rec = { key: p.key, label: p.label, url: p.url, device, avg_scroll_depth_pct: p.scroll };
    let s;
    try {
      s = await openPage({ device, settleMs: 8000 });
      const nav = await goto(s.page, p.url, s.settleMs);
      rec.http_status = nav.status;

      process.stderr.write("overlays ");
      const ov = await overlayAudit(s.page);
      const big = ov.overlays.find(o => o.coverage_pct >= 25) || null;
      rec.overlays = {
        body_scroll_locked: ov.bodyScrollLocked,
        blocking: big ? { coverage_pct: big.coverage_pct, z: big.z, text: big.text.slice(0, 140) } : null,
        centre_click_hits: ov.blocking ? (ov.blocking.text?.slice(0, 90) || ov.blocking.tag) : null,
        all: ov.overlays.slice(0, 5).map(o => ({ coverage_pct: o.coverage_pct, z: o.z, text: o.text.slice(0, 90) })),
      };
      const overlayShot = path.join(CAPS, `overlay-${id}.png`);
      await s.page.screenshot({ path: overlayShot });
      rec.screenshot_viewport = path.relative(ROOT, overlayShot);

      process.stderr.write("fold ");
      await primeLazyContent(s.page);
      const fold = await foldAnalysis(s.page);
      const reach = Math.round(fold.doc_height_px * p.scroll / 100);
      rec.fold = {
        doc_height_px: fold.doc_height_px,
        screens_tall: fold.screens_tall,
        avg_scroll_reach_px: reach,
        elements: fold.elements.map(e => ({
          label: e.label, present: e.present, sticky: e.sticky ?? null,
          pct_down: e.pct_down ?? null, top_px: e.top_px ?? null,
          seen_by_median: !e.present ? null : e.sticky ? true : e.top_px <= reach,
        })),
      };

      process.stderr.write("vitals ");
      const v = await collectVitals(s.page);
      rec.vitals = { ...v, js_errors: s.jsErrors.length, js_error_samples: s.jsErrors.slice(0, 3) };

      if (p.clicks.length) {
        process.stderr.write("heatmap ");
        const loc = await locateByText(s.page, p.clicks.map(c => c.needle));
        const spots = [], unmatched = [];
        loc.forEach((l, i) => {
          const c = p.clicks[i];
          if (l.matched) spots.push({ x: l.x, y: l.y, w: l.w, h: l.h, count: c.count, label: c.label });
          else unmatched.push({ text: c.text, count: c.count });
        });
        rec.heatmap = { matched: spots.length, unmatched };
        if (spots.length) {
          await paintHeatmap(s.page, spots, {
            scrollReachPct: p.scroll,
            title: `${p.label} — click heatmap (${device}) · Clarity 19–25 Jul`,
          });
          const hm = path.join(CAPS, `heatmap-${id}.png`);
          await s.page.screenshot({ path: hm, fullPage: true });
          rec.heatmap.image = path.relative(ROOT, hm);
        }
      }
      process.stderr.write("ok");
    } catch (e) {
      rec.error = String(e?.message || e).slice(0, 300);
      process.stderr.write(`FAIL ${rec.error}`);
    } finally {
      if (s?.context) await s.context.close().catch(() => {});
    }
    out.pages[id] = rec;
  }
}

await closeBrowser();
const dest = path.join(ROOT, "data", "lab_capture.json");
await writeFile(dest, JSON.stringify(out, null, 1), "utf8");
process.stderr.write(`\n\nwrote ${path.relative(ROOT, dest)}\n`);
