/**
 * Tests the cart -> checkout transition, which is where the funnel loses 92.7%
 * of mobile users. Adds a real item, clicks PROCEED TO CHECKOUT, and records
 * whether a login/OTP wall appears and whether a guest path exists.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { openPage, goto, primeLazyContent, closeBrowser } from "./lib/browser.js";
import { overlayAudit } from "./lib/measure.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CAPS = path.join(ROOT, "reports", "captures");
const SITE = "https://www.lucirajewelry.com";
const device = process.argv[2] || "mobile";

const log = [];
const s = await openPage({ device, settleMs: 8000 });
const { page } = s;

const probe = async (label) => {
  const f = path.join(CAPS, `gate-${log.length + 1}-${label}-${device}.png`);
  await page.screenshot({ path: f });
  const ov = await overlayAudit(page);
  const big = ov.overlays.find(o => o.coverage_pct >= 25) || null;
  const state = await page.evaluate(() => {
    const t = document.body.innerText || "";
    return {
      login_wall: /login to your account|request otp|enter phone number|verify otp/i.test(t),
      guest_option: /guest|continue without|skip (login|sign)/i.test(t),
      asks_phone: !!document.querySelector('input[type=tel],input[name*=phone i],input[placeholder*=phone i]'),
      visible_ctas: [...document.querySelectorAll("button,a,[role=button]")]
        .filter(b => b.offsetParent !== null && (b.innerText || "").trim().length > 2)
        .map(b => (b.innerText || "").trim().replace(/\s+/g, " ").slice(0, 34)).slice(0, 12),
    };
  });
  const rec = { step: log.length + 1, label, url: page.url(),
    screenshot: path.relative(ROOT, f),
    blocking_overlay: big ? { coverage_pct: big.coverage_pct, z: big.z, text: big.text.slice(0, 100) } : null,
    ...state };
  log.push(rec);
  process.stderr.write(`\n[${rec.step}] ${label}\n    url=${rec.url}\n    login_wall=${state.login_wall} asks_phone=${state.asks_phone} guest=${state.guest_option}` +
    (big ? `\n    BLOCKING ${big.coverage_pct}% :: ${big.text.slice(0, 70)}` : ""));
  return rec;
};

// Land on a PDP, clear the first-page modal, add an item.
await goto(page, `${SITE}/products/corinthian-pave-diamond-mens-ring`, s.settleMs);
await probe("pdp_landing");

await page.evaluate(() => {
  const btn = [...document.querySelectorAll("*")].find(e => {
    if (e.children.length) return false;
    const t = (e.innerText || "").trim();
    return t === "✕" || t === "×" || t === "X";
  });
  if (btn) { (btn.closest("button,[role=button],a") || btn).click(); return; }
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
});
await page.waitForTimeout(2500);
await primeLazyContent(page);

const atc = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button,a,[role=button]")]
    .find(x => x.offsetParent !== null && /add to (cart|bag)/i.test(x.innerText || ""));
  if (!b) return false;
  b.scrollIntoView({ block: "center" }); b.click(); return true;
});
await page.waitForTimeout(5000);
process.stderr.write(`\n    add_to_cart_clicked=${atc}`);

await goto(page, `${SITE}/checkout/cart`, s.settleMs);
await probe("cart_with_item");

// The decisive click.
const clicked = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button,a,[role=button]")]
    .find(x => x.offsetParent !== null && /proceed to checkout|checkout|place order/i.test(x.innerText || ""));
  if (!b) return { found: false };
  b.scrollIntoView({ block: "center" }); b.click();
  return { found: true, text: (b.innerText || "").trim().slice(0, 40) };
});
process.stderr.write(`\n    checkout_cta=${JSON.stringify(clicked)}`);
await page.waitForTimeout(9000);
await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
const after = await probe("after_checkout_click");
after.checkout_cta = clicked;

await s.context.close();
await closeBrowser();
const dest = path.join(ROOT, "data", `checkout_gate_${device}.json`);
await writeFile(dest, JSON.stringify({ device, generated_at: new Date().toISOString(), steps: log, js_errors: s.jsErrors.slice(0, 6) }, null, 1), "utf8");
process.stderr.write(`\n\nwrote ${path.relative(ROOT, dest)}\n`);
