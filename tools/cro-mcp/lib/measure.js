/**
 * In-page measurement routines. Everything here runs inside the browser via
 * page.evaluate, so it sees real rendered geometry rather than guessed layout.
 */

/** Default CRO-relevant elements to locate. Order matters only for readability. */
export const DEFAULT_LABELS = [
  { label: "Price",             pattern: "₹\\s?[\\d,]{3,}" },
  { label: "Add to Cart",       pattern: "add to (cart|bag)" },
  { label: "Buy Now",           pattern: "buy (it )?now" },
  { label: "Checkout",          pattern: "check\\s?out|continue to payment|place order|pay now" },
  { label: "Variant selector",  pattern: "^(yellow|white|rose)( gold)?$|select (size|metal|colou?r)" },
  { label: "Size guide",        pattern: "size guide|ring siz" },
  { label: "Certification",     pattern: "certif|igi|gia|hallmark" },
  { label: "Returns / exchange",pattern: "return|exchange|guarantee" },
  { label: "Shipping info",     pattern: "shipping|delivery" },
  { label: "EMI / financing",   pattern: "\\bemi\\b|instal?ment|monthly plan" },
  { label: "Reviews",           pattern: "customer review|ratings? & reviews|write a review" },
  { label: "Product details",   pattern: "product details|description|specification" },
  { label: "Try at home",       pattern: "try at home|book an appointment|video call" },
];

export async function foldAnalysis(page, labels = DEFAULT_LABELS) {
  return page.evaluate((labelDefs) => {
    const vh = window.innerHeight;
    const dh = document.documentElement.scrollHeight;

    const visible = el => {
      if (!el.isConnected) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };

    // Leaf nodes only — otherwise a wrapper <div> matches every keyword inside it.
    const leaves = [...document.querySelectorAll("body *")]
      .filter(e => e.children.length === 0 && visible(e));

    const found = [];
    for (const { label, pattern } of labelDefs) {
      const re = new RegExp(pattern, "i");
      const el = leaves.find(e => re.test((e.innerText || e.textContent || "").trim()));
      if (!el) { found.push({ label, present: false }); continue; }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      let sticky = cs.position === "sticky" || cs.position === "fixed";
      // A sticky ancestor pins the child too.
      for (let p = el.parentElement; p && !sticky; p = p.parentElement) {
        const pp = getComputedStyle(p).position;
        if (pp === "sticky" || pp === "fixed") sticky = true;
      }
      const top = Math.round(r.top + window.scrollY);
      found.push({
        label, present: true, sticky,
        top_px: top,
        pct_down: dh ? +((top / dh) * 100).toFixed(1) : null,
        fold: vh ? +(top / vh).toFixed(2) : null,
        text: (el.innerText || el.textContent || "").trim().slice(0, 60),
      });
    }

    return {
      url: location.href,
      viewport: { width: window.innerWidth, height: vh },
      doc_height_px: dh,
      screens_tall: vh ? +(dh / vh).toFixed(1) : null,
      elements: found,
    };
  }, labels);
}

/**
 * Locate elements by their visible text and return document-space boxes.
 * This is what turns Clarity's "clicked text -> count" table into real
 * heatmap coordinates.
 */
export async function locateByText(page, texts) {
  return page.evaluate((needles) => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const visible = el => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const all = [...document.querySelectorAll("body *")].filter(visible);

    return needles.map(n => {
      const want = norm(n);
      if (!want) return { needle: n, matched: false, reason: "empty needle" };
      // Prefer the smallest element containing the text — the actual control,
      // not the section wrapping it.
      const hits = all.filter(e => norm(e.innerText || e.textContent).includes(want));
      if (!hits.length) return { needle: n, matched: false };
      hits.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.width * ra.height) - (rb.width * rb.height);
      });
      const el = hits[0];
      const r = el.getBoundingClientRect();
      return {
        needle: n, matched: true,
        tag: el.tagName.toLowerCase(),
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    });
  }, texts);
}

/**
 * Find overlays that sit above the page and can intercept clicks.
 * document.elementFromPoint at the viewport centre is the ground truth for
 * "is something blocking interaction" — a high z-index alone proves nothing.
 */
export async function overlayAudit(page) {
  return page.evaluate(() => {
    const out = { overlays: [], blocking: null, bodyScrollLocked: false };
    const cs = getComputedStyle(document.body);
    out.bodyScrollLocked = cs.overflow === "hidden" || cs.position === "fixed";

    const candidates = [...document.querySelectorAll("body *")].filter(e => {
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden" || +s.opacity === 0) return false;
      const z = parseInt(s.zIndex, 10);
      const fixed = s.position === "fixed" || s.position === "sticky";
      const r = e.getBoundingClientRect();
      const big = r.width * r.height > (window.innerWidth * window.innerHeight) * 0.12;
      return (Number.isFinite(z) && z >= 100 && (fixed || big)) || (fixed && big);
    });

    const seen = new Set();
    for (const e of candidates) {
      // Skip elements whose ancestor is already reported.
      let dup = false;
      for (let p = e.parentElement; p; p = p.parentElement) if (seen.has(p)) { dup = true; break; }
      if (dup) continue;
      seen.add(e);
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      out.overlays.push({
        tag: e.tagName.toLowerCase(),
        id: e.id || null,
        cls: (e.className || "").toString().slice(0, 80),
        z: s.zIndex,
        position: s.position,
        box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        coverage_pct: +(((r.width * r.height) / (window.innerWidth * window.innerHeight)) * 100).toFixed(1),
        text: (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120),
      });
    }
    out.overlays.sort((a, b) => b.coverage_pct - a.coverage_pct);

    const cx = Math.round(window.innerWidth / 2), cy = Math.round(window.innerHeight / 2);
    const hit = document.elementFromPoint(cx, cy);
    if (hit) {
      out.blocking = {
        at: { x: cx, y: cy },
        tag: hit.tagName.toLowerCase(),
        cls: (hit.className || "").toString().slice(0, 80),
        text: (hit.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120),
      };
    }
    return out;
  });
}

/** Real-user-style vitals from the Performance API after a full navigation. */
export async function collectVitals(page) {
  return page.evaluate(() => new Promise(resolve => {
    const out = { lcp_ms: null, cls: null, fcp_ms: null, ttfb_ms: null, dom_content_loaded_ms: null, load_ms: null };
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) {
      out.ttfb_ms = Math.round(nav.responseStart);
      out.dom_content_loaded_ms = Math.round(nav.domContentLoadedEventEnd);
      out.load_ms = Math.round(nav.loadEventEnd || 0);
    }
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    if (fcp) out.fcp_ms = Math.round(fcp.startTime);

    let cls = 0;
    try {
      new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; })
        .observe({ type: "layout-shift", buffered: true });
    } catch {}
    try {
      new PerformanceObserver(l => {
        const es = l.getEntries();
        if (es.length) out.lcp_ms = Math.round(es[es.length - 1].startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}

    setTimeout(() => { out.cls = +cls.toFixed(4); resolve(out); }, 1200);
  }));
}
