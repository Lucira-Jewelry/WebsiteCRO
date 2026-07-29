#!/usr/bin/env node
/**
 * cro-mcp — Playwright-backed MCP server for CRO measurement.
 *
 * Why a custom server rather than the official @playwright/mcp: that one exposes
 * generic browser automation (click, type, snapshot). These tools answer CRO
 * questions directly — where does the fold fall, what covers the page, where did
 * the clicks land — and return structured numbers rather than a DOM dump, which
 * keeps them cheap to read into context.
 *
 * Uses the low-level Server API deliberately: it has been stable across SDK
 * versions, so this won't break on a minor bump.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { openPage, goto, primeLazyContent, closeBrowser, DEVICES } from "./lib/browser.js";
import { foldAnalysis, locateByText, overlayAudit, collectVitals, DEFAULT_LABELS } from "./lib/measure.js";
import { paintHeatmap } from "./lib/heatmap.js";

const OUT_DIR = process.env.CRO_OUT_DIR
  || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../reports/captures");

async function outPath(name) {
  await mkdir(OUT_DIR, { recursive: true });
  return path.join(OUT_DIR, name);
}
const ok = obj => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const fail = msg => ({ content: [{ type: "text", text: JSON.stringify({ error: String(msg) }, null, 1) }], isError: true });

const deviceProp = { type: "string", enum: Object.keys(DEVICES), default: "mobile", description: "Device profile." };
const urlProp = { type: "string", description: "Absolute URL to load." };

const TOOLS = [
  {
    name: "cro_screenshot",
    description: "Capture a screenshot at a device profile. Waits for network idle plus a settle delay so conditionally-triggered popups appear. Set fullPage for the whole document.",
    inputSchema: { type: "object", required: ["url"], properties: {
      url: urlProp, device: deviceProp,
      fullPage: { type: "boolean", default: true },
      settleMs: { type: "number", default: 6000, description: "Extra wait after load for delayed overlays." },
      filename: { type: "string", description: "Output filename; auto-generated if omitted." },
    } },
  },
  {
    name: "cro_fold_analysis",
    description: "Measure where CRO-relevant elements sit in the document (price, add-to-cart, reviews, certification, shipping, EMI...) and how that compares to a given average scroll depth. Returns page height in screens plus each element's pixel depth, % down page and sticky status.",
    inputSchema: { type: "object", required: ["url"], properties: {
      url: urlProp, device: deviceProp,
      avgScrollDepthPct: { type: "number", description: "Measured average scroll depth (e.g. from Clarity) — used to flag which elements the median visitor never reaches." },
      settleMs: { type: "number", default: 6000 },
      labels: { type: "array", description: "Override the default element set.", items: { type: "object", required: ["label", "pattern"], properties: {
        label: { type: "string" }, pattern: { type: "string", description: "Case-insensitive regex matched against element text." } } } },
    } },
  },
  {
    name: "cro_heatmap",
    description: "Render a real click heatmap image. Supply Clarity's clicked-text/count pairs; Playwright resolves each text to its live position and paints intensity-scaled blobs onto a full-page screenshot, optionally with the average-scroll-depth line. Returns the image path plus which texts could not be matched.",
    inputSchema: { type: "object", required: ["url", "clicks"], properties: {
      url: urlProp, device: deviceProp,
      clicks: { type: "array", description: "Clicked elements and their counts.", items: { type: "object", required: ["text", "count"], properties: {
        text: { type: "string", description: "Visible text of the clicked element (as Clarity reports it)." },
        count: { type: "number" },
        label: { type: "string", description: "Optional short label drawn on the blob, e.g. 'popup'." } } } },
      avgScrollDepthPct: { type: "number" },
      title: { type: "string" },
      settleMs: { type: "number", default: 6000 },
      filename: { type: "string" },
    } },
  },
  {
    name: "cro_overlay_audit",
    description: "Detect popups, modals and fixed overlays, how much of the viewport each covers, whether body scroll is locked, and — critically — which element actually receives a click at the viewport centre. This is how you prove an overlay is blocking interaction rather than merely present.",
    inputSchema: { type: "object", required: ["url"], properties: {
      url: urlProp, device: deviceProp,
      settleMs: { type: "number", default: 8000 },
      screenshot: { type: "boolean", default: true },
      filename: { type: "string" },
    } },
  },
  {
    name: "cro_vitals",
    description: "Measure Core Web Vitals (LCP, CLS, FCP, TTFB) from a real navigation, plus transfer weight, request count and JS errors. Runs several times and returns the median LCP, since single-run LCP is noisy.",
    inputSchema: { type: "object", required: ["url"], properties: {
      url: urlProp, device: deviceProp,
      runs: { type: "number", default: 3, description: "Navigations to median across." },
    } },
  },
  {
    name: "cro_funnel_walk",
    description: "Drive the real purchase funnel — collection page, product page, add to cart, cart — screenshotting each step and auditing overlays at every stage. This reproduces funnel drop-off in the live UI instead of inferring it from analytics.",
    inputSchema: { type: "object", required: ["startUrl"], properties: {
      startUrl: { type: "string", description: "Collection or category URL to start from." },
      device: deviceProp,
      settleMs: { type: "number", default: 6000 },
      cartUrl: { type: "string", description: "Cart URL to finish on." },
      prefix: { type: "string", default: "funnel" },
    } },
  },
];

const server = new Server({ name: "cro-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let session;
  try {
    switch (name) {
      case "cro_screenshot": {
        session = await openPage({ device: a.device, settleMs: a.settleMs ?? 6000 });
        const nav = await goto(session.page, a.url, session.settleMs);
        if (a.fullPage !== false) await primeLazyContent(session.page);
        const file = await outPath(a.filename || `shot-${a.device || "mobile"}-${stamp}.png`);
        await session.page.screenshot({ path: file, fullPage: a.fullPage !== false });
        const dims = await session.page.evaluate(() => ({
          doc_height_px: document.documentElement.scrollHeight, viewport_height_px: window.innerHeight,
        }));
        return ok({ screenshot: file, ...nav, ...dims,
          screens_tall: +(dims.doc_height_px / dims.viewport_height_px).toFixed(1),
          js_errors: session.jsErrors.slice(0, 5) });
      }

      case "cro_fold_analysis": {
        session = await openPage({ device: a.device, settleMs: a.settleMs ?? 6000 });
        await goto(session.page, a.url, session.settleMs);
        await primeLazyContent(session.page);
        const fold = await foldAnalysis(session.page, a.labels?.length ? a.labels : DEFAULT_LABELS);
        const reach = a.avgScrollDepthPct != null
          ? Math.round(fold.doc_height_px * a.avgScrollDepthPct / 100) : null;
        const elements = fold.elements.map(e => ({
          ...e,
          seen_by_median_visitor: !e.present ? null
            : e.sticky ? true
            : reach == null ? null : e.top_px <= reach,
        }));
        return ok({ ...fold, elements,
          avg_scroll_depth_pct: a.avgScrollDepthPct ?? null,
          avg_scroll_reach_px: reach,
          page_never_seen_pct: a.avgScrollDepthPct != null ? +(100 - a.avgScrollDepthPct).toFixed(1) : null });
      }

      case "cro_heatmap": {
        session = await openPage({ device: a.device, settleMs: a.settleMs ?? 6000 });
        await goto(session.page, a.url, session.settleMs);
        await primeLazyContent(session.page);
        const located = await locateByText(session.page, a.clicks.map(c => c.text));
        const spots = [], unmatched = [];
        located.forEach((loc, i) => {
          const c = a.clicks[i];
          if (loc.matched) spots.push({ x: loc.x, y: loc.y, w: loc.w, h: loc.h, count: c.count, label: c.label || null });
          else unmatched.push({ text: c.text, count: c.count });
        });
        if (!spots.length) return fail("No supplied click texts could be located on the page — check the URL and that the texts match visible content.");
        await paintHeatmap(session.page, spots, {
          scrollReachPct: a.avgScrollDepthPct ?? null,
          title: a.title || `Click heatmap — ${a.device || "mobile"}`,
        });
        const file = await outPath(a.filename || `heatmap-${a.device || "mobile"}-${stamp}.png`);
        await session.page.screenshot({ path: file, fullPage: true });
        return ok({ heatmap: file, matched: spots.length, unmatched,
          note: unmatched.length ? "Unmatched texts are usually overlay content that did not render this visit, or elements Clarity captured with truncated text." : undefined });
      }

      case "cro_overlay_audit": {
        session = await openPage({ device: a.device, settleMs: a.settleMs ?? 8000 });
        await goto(session.page, a.url, session.settleMs);
        const audit = await overlayAudit(session.page);
        let shot = null;
        if (a.screenshot !== false) {
          shot = await outPath(a.filename || `overlay-${a.device || "mobile"}-${stamp}.png`);
          await session.page.screenshot({ path: shot, fullPage: false });
        }
        const blocker = audit.overlays.find(o => o.coverage_pct >= 25) || null;
        return ok({ ...audit, screenshot: shot,
          verdict: blocker
            ? `Overlay covering ${blocker.coverage_pct}% of the viewport: "${(blocker.text || blocker.cls).slice(0, 80)}"`
            : "No large blocking overlay detected on this visit.",
          js_errors: session.jsErrors.slice(0, 5) });
      }

      case "cro_vitals": {
        const runs = Math.max(1, Math.min(5, a.runs ?? 3));
        const all = [];
        for (let i = 0; i < runs; i++) {
          session = await openPage({ device: a.device, settleMs: 2500 });
          let bytes = 0, reqs = 0;
          session.page.on("response", async r => {
            reqs++;
            try { const b = (await r.body()).length; bytes += b; } catch {}
          });
          await goto(session.page, a.url, session.settleMs);
          const v = await collectVitals(session.page);
          all.push({ ...v, requests: reqs, transfer_bytes: bytes, js_errors: session.jsErrors.length });
          await session.context.close(); session = null;
        }
        const med = key => {
          const xs = all.map(r => r[key]).filter(v => typeof v === "number").sort((x, y) => x - y);
          return xs.length ? xs[Math.floor(xs.length / 2)] : null;
        };
        const lcp = med("lcp_ms");
        return ok({ url: a.url, device: a.device || "mobile", runs,
          median: { lcp_ms: lcp, cls: med("cls"), fcp_ms: med("fcp_ms"), ttfb_ms: med("ttfb_ms"),
                    requests: med("requests"), transfer_kb: med("transfer_bytes") != null ? Math.round(med("transfer_bytes") / 1024) : null },
          lcp_rating: lcp == null ? null : lcp <= 2500 ? "good" : lcp <= 4000 ? "needs-improvement" : "poor",
          runs_detail: all });
      }

      case "cro_funnel_walk": {
        session = await openPage({ device: a.device, settleMs: a.settleMs ?? 6000 });
        const { page } = session;
        const steps = [];
        const capture = async (label, url) => {
          const file = await outPath(`${a.prefix || "funnel"}-${steps.length + 1}-${label}-${a.device || "mobile"}-${stamp}.png`);
          await page.screenshot({ path: file, fullPage: false });
          const audit = await overlayAudit(page);
          const big = audit.overlays.find(o => o.coverage_pct >= 25) || null;
          steps.push({ step: steps.length + 1, label, url: url ?? page.url(), screenshot: file,
            body_scroll_locked: audit.bodyScrollLocked,
            click_at_centre_hits: audit.blocking?.text?.slice(0, 90) || audit.blocking?.tag || null,
            blocking_overlay: big ? { coverage_pct: big.coverage_pct, text: (big.text || big.cls).slice(0, 90) } : null });
        };

        await goto(page, a.startUrl, session.settleMs);
        await capture("collection");

        // First product link on the collection page.
        const href = await page.evaluate(() => {
          const a = [...document.querySelectorAll('a[href*="/products/"]')].find(x => x.offsetParent !== null);
          return a ? a.href : null;
        });
        if (href) {
          await goto(page, href, session.settleMs);
          await primeLazyContent(page);
          await capture("product");

          const added = await page.evaluate(() => {
            const btn = [...document.querySelectorAll("button,a,[role=button]")]
              .find(b => b.offsetParent !== null && /add to (cart|bag)/i.test(b.innerText || ""));
            if (!btn) return false;
            btn.click(); return true;
          });
          await page.waitForTimeout(4000);
          steps.push({ step: steps.length + 1, label: "add_to_cart_clicked", add_to_cart_found: added });
          if (added) await capture("after_add_to_cart");
        } else {
          steps.push({ step: steps.length + 1, label: "product", error: "No product link found on the collection page." });
        }

        if (a.cartUrl) {
          await goto(page, a.cartUrl, session.settleMs);
          await capture("cart");
          const cartState = await page.evaluate(() => ({
            looks_empty: /your cart is empty|cart is empty/i.test(document.body.innerText || ""),
            has_checkout_cta: [...document.querySelectorAll("button,a,[role=button]")]
              .some(b => b.offsetParent !== null && /check\s?out|proceed|place order/i.test(b.innerText || "")),
          }));
          steps[steps.length - 1].cart_state = cartState;
        }
        return ok({ device: a.device || "mobile", steps, js_errors: session.jsErrors.slice(0, 8) });
      }

      default: return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return fail(e?.stack || e?.message || e);
  } finally {
    if (session?.context) await session.context.close().catch(() => {});
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { await closeBrowser(); process.exit(0); });
}

await server.connect(new StdioServerTransport());
