import { chromium } from "playwright";

export const DEVICES = {
  mobile:  { width: 375,  height: 812,  deviceScaleFactor: 2, isMobile: true,  hasTouch: true,
             userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  tablet:  { width: 768,  height: 1024, deviceScaleFactor: 2, isMobile: true,  hasTouch: true },
  desktop: { width: 1440, height: 900,  deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};

let browser = null;

export async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
  return browser;
}

export async function closeBrowser() {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

/**
 * Open a page with the given device profile and collect console/JS errors.
 * `settleMs` gives conditionally-triggered overlays (spin-wheel, login modals)
 * time to appear — they are the whole point of the overlay audit, and a bare
 * `load` wait misses them entirely.
 */
export async function openPage({ device = "mobile", settleMs = 6000, blockAnalytics = false } = {}) {
  const profile = DEVICES[device] ?? DEVICES.mobile;
  const b = await getBrowser();
  const context = await b.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  });

  if (blockAnalytics) {
    await context.route(/(google-analytics|googletagmanager|facebook\.net|criteo|clarity\.ms)/, r => r.abort());
  }

  const page = await context.newPage();
  const jsErrors = [];
  const consoleErrors = [];
  page.on("pageerror", e => jsErrors.push(String(e.message).slice(0, 300)));
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });

  return { context, page, profile, jsErrors, consoleErrors, settleMs };
}

/** Navigate, then wait for the network to go quiet AND overlays to settle. */
export async function goto(page, url, settleMs = 6000) {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(settleMs);
  return { status: resp?.status() ?? null, finalUrl: page.url() };
}

/** Scroll the full page in steps so lazy-loaded content renders, then return to top. */
export async function primeLazyContent(page) {
  await page.evaluate(async () => {
    const step = window.innerHeight;
    const total = document.documentElement.scrollHeight;
    for (let y = 0; y < total; y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 400));
  });
}
