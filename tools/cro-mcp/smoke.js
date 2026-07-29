/** Direct exercise of the measurement layer — verifies the tools work before MCP wiring. */
import { openPage, goto, primeLazyContent, closeBrowser } from "./lib/browser.js";
import { foldAnalysis, overlayAudit, collectVitals } from "./lib/measure.js";

const URL = process.argv[2] || "https://www.lucirajewelry.com/products/corinthian-pave-diamond-mens-ring";
const DEVICE = process.argv[3] || "mobile";

const s = await openPage({ device: DEVICE, settleMs: 7000 });
const nav = await goto(s.page, URL, s.settleMs);
console.log(JSON.stringify({ step: "navigate", ...nav }));

await primeLazyContent(s.page);

const fold = await foldAnalysis(s.page);
console.log(JSON.stringify({
  step: "fold",
  doc_height_px: fold.doc_height_px,
  screens_tall: fold.screens_tall,
  present: fold.elements.filter(e => e.present).map(e => `${e.label}@${e.pct_down}%${e.sticky ? " (sticky)" : ""}`),
  missing: fold.elements.filter(e => !e.present).map(e => e.label),
}));

const ov = await overlayAudit(s.page);
console.log(JSON.stringify({
  step: "overlays",
  body_scroll_locked: ov.bodyScrollLocked,
  top: ov.overlays.slice(0, 4).map(o => ({ cov: o.coverage_pct, z: o.z, txt: o.text.slice(0, 60) })),
  centre_click_hits: ov.blocking?.text?.slice(0, 70) || ov.blocking?.tag,
}));

const v = await collectVitals(s.page);
console.log(JSON.stringify({ step: "vitals", ...v, js_errors: s.jsErrors.length }));

await s.context.close();
await closeBrowser();
