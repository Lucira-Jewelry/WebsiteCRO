/**
 * Walks the real purchase funnel on mobile: collection -> product -> dismiss the
 * blocking modal -> add to cart -> cart. Records whether each step was reachable
 * and what the modal cost, which is the part analytics cannot show.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { openPage, goto, primeLazyContent, closeBrowser } from "./lib/browser.js";
import { overlayAudit } from "./lib/measure.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CAPS = path.join(ROOT, "reports", "captures");
const SITE = "https://www.lucirajewelry.com";
const device = process.argv[2] || "mobile";

const steps = [];
const s = await openPage({ device, settleMs: 8000 });
const { page } = s;

async function snap(label) {
  const f = path.join(CAPS, `funnel-${steps.length + 1}-${label}-${device}.png`);
  await page.screenshot({ path: f });
  const ov = await overlayAudit(page);
  const big = ov.overlays.find(o => o.coverage_pct >= 25) || null;
  const rec = {
    step: steps.length + 1, label, url: page.url(),
    screenshot: path.relative(ROOT, f),
    blocking_overlay: big ? { coverage_pct: big.coverage_pct, z: big.z, text: big.text.slice(0, 90) } : null,
    centre_click_hits: ov.blocking ? (ov.blocking.text?.slice(0, 70) || ov.blocking.tag) : null,
  };
  steps.push(rec);
  process.stderr.write(`\n[${rec.step}] ${label} :: ${big ? `BLOCKED ${big.coverage_pct}%` : "clear"}`);
  return rec;
}

/** Try every plausible dismissal affordance and report which one worked. */
async function dismissModal() {
  const r = await page.evaluate(() => {
    const vis = e => e.offsetParent !== null || getComputedStyle(e).position === "fixed";
    const cands = [...document.querySelectorAll("button,[role=button],a,span,div,svg,img")].filter(vis);
    const byLabel = cands.find(e =>
      /^(×|✕|✖|x|close|no thanks|maybe later|skip)$/i.test((e.innerText || "").trim()) ||
      /close|dismiss/i.test(e.getAttribute("aria-label") || "") ||
      /close|dismiss/i.test(e.className?.toString?.() || ""));
    if (byLabel) { byLabel.click(); return { method: "close-affordance", text: (byLabel.innerText || byLabel.getAttribute("aria-label") || byLabel.className).toString().slice(0, 40) }; }
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return { method: "escape-key" };
  });
  await page.waitForTimeout(2500);
  const ov = await overlayAudit(page);
  const still = ov.overlays.find(o => o.coverage_pct >= 25) || null;
  process.stderr.write(`  dismiss(${r.method}) -> ${still ? "STILL BLOCKED" : "cleared"}`);
  return { ...r, cleared: !still };
}

await goto(page, `${SITE}/collections/eterna`, s.settleMs);
await snap("collection");
const d1 = await dismissModal();
steps[steps.length - 1].dismiss = d1;

const href = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a[href*="/products/"]')].find(x => x.offsetParent !== null);
  return a ? a.href : null;
});

if (!href) {
  steps.push({ step: steps.length + 1, label: "product", error: "no product link reachable on collection page" });
} else {
  await goto(page, href, s.settleMs);
  await snap("product");
  const d2 = await dismissModal();
  steps[steps.length - 1].dismiss = d2;
  await primeLazyContent(page);

  const atc = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button,a,[role=button]")]
      .find(x => x.offsetParent !== null && /add to (cart|bag)/i.test(x.innerText || ""));
    if (!b) return { found: false };
    b.scrollIntoView({ block: "center" }); b.click();
    return { found: true, text: (b.innerText || "").trim().slice(0, 40) };
  });
  await page.waitForTimeout(5000);
  const r = await snap("after_add_to_cart");
  r.add_to_cart = atc;
}

await goto(page, `${SITE}/checkout/cart`, s.settleMs);
const cartRec = await snap("cart");
cartRec.cart_state = await page.evaluate(() => {
  const t = document.body.innerText || "";
  return {
    looks_empty: /your cart is empty|cart is empty/i.test(t),
    doc_height_px: document.documentElement.scrollHeight,
    screens_tall: +(document.documentElement.scrollHeight / window.innerHeight).toFixed(1),
    checkout_cta: [...document.querySelectorAll("button,a,[role=button]")]
      .filter(b => b.offsetParent !== null && /check\s?out|proceed|place order|continue/i.test(b.innerText || ""))
      .map(b => (b.innerText || "").trim().slice(0, 40)).slice(0, 4),
    login_wall: /login to your account|request otp|enter phone number/i.test(t),
  };
});

await s.context.close();
await closeBrowser();

const dest = path.join(ROOT, "data", `funnel_walk_${device}.json`);
await writeFile(dest, JSON.stringify({ device, generated_at: new Date().toISOString(), steps, js_errors: s.jsErrors.slice(0, 6) }, null, 1), "utf8");
process.stderr.write(`\n\nwrote ${path.relative(ROOT, dest)}\n`);
