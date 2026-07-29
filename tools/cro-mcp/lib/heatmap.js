/**
 * Renders a click heatmap onto the live page, then screenshots it.
 *
 * Clarity's API gives click counts keyed by element *text*, not coordinates —
 * so a real heatmap image is impossible from the API alone. This bridges the
 * gap: Playwright resolves each text to a live bounding box, and the counts are
 * painted at those positions. Intensity is scaled against the largest count on
 * the page, so the image reads as "where the attention went", not raw volume.
 */

const PALETTE = [
  { stop: 0.00, rgb: "0,90,190" },    // cold  — few clicks
  { stop: 0.35, rgb: "0,170,140" },
  { stop: 0.60, rgb: "225,175,40" },
  { stop: 0.80, rgb: "230,110,30" },
  { stop: 1.00, rgb: "200,30,30" },   // hot   — most-clicked
];

function colorFor(t) {
  let lo = PALETTE[0], hi = PALETTE[PALETTE.length - 1];
  for (let i = 0; i < PALETTE.length - 1; i++) {
    if (t >= PALETTE[i].stop && t <= PALETTE[i + 1].stop) { lo = PALETTE[i]; hi = PALETTE[i + 1]; break; }
  }
  const span = hi.stop - lo.stop || 1;
  const f = (t - lo.stop) / span;
  const a = lo.rgb.split(",").map(Number), b = hi.rgb.split(",").map(Number);
  return a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(",");
}

/**
 * @param page        Playwright page, already navigated
 * @param spots       [{ x, y, w, h, count, label, kind }] in document coords
 * @param opts.scrollReachPct  draws the "average visitor stops here" line
 * @param opts.title  caption burned into the image
 */
export async function paintHeatmap(page, spots, opts = {}) {
  const max = Math.max(...spots.map(s => s.count || 0), 1);
  const enriched = spots.map(s => {
    // sqrt keeps one dominant element from flattening everything else to invisible
    const t = Math.sqrt((s.count || 0) / max);
    return { ...s, t, rgb: colorFor(t), radius: Math.round(46 + t * 120) };
  });

  await page.evaluate(({ spots, scrollReachPct, title, max }) => {
    document.getElementById("__cro_heat")?.remove();
    const root = document.createElement("div");
    root.id = "__cro_heat";
    Object.assign(root.style, {
      position: "absolute", left: "0", top: "0", width: "100%",
      height: document.documentElement.scrollHeight + "px",
      pointerEvents: "none", zIndex: "2147483646",
    });

    for (const s of spots) {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const blob = document.createElement("div");
      Object.assign(blob.style, {
        position: "absolute",
        left: (cx - s.radius) + "px", top: (cy - s.radius) + "px",
        width: (s.radius * 2) + "px", height: (s.radius * 2) + "px",
        borderRadius: "50%",
        background: `radial-gradient(circle, rgba(${s.rgb},0.78) 0%, rgba(${s.rgb},0.45) 42%, rgba(${s.rgb},0) 72%)`,
        mixBlendMode: "multiply",
      });
      root.appendChild(blob);

      const ring = document.createElement("div");
      Object.assign(ring.style, {
        position: "absolute",
        left: s.x + "px", top: s.y + "px",
        width: s.w + "px", height: s.h + "px",
        border: `2px solid rgba(${s.rgb},0.95)`, borderRadius: "4px",
        boxShadow: "0 0 0 1px rgba(255,255,255,.7)",
      });
      root.appendChild(ring);

      const tag = document.createElement("div");
      tag.textContent = `${s.count.toLocaleString("en-IN")}${s.label ? " · " + s.label : ""}`;
      Object.assign(tag.style, {
        position: "absolute",
        left: s.x + "px", top: Math.max(0, s.y - 20) + "px",
        font: "700 11px/1.4 -apple-system,Segoe UI,Roboto,sans-serif",
        color: "#fff", background: `rgba(${s.rgb},0.95)`,
        padding: "1px 6px", borderRadius: "3px", whiteSpace: "nowrap",
      });
      root.appendChild(tag);
    }

    if (scrollReachPct != null) {
      const y = Math.round(document.documentElement.scrollHeight * scrollReachPct / 100);
      const line = document.createElement("div");
      Object.assign(line.style, {
        position: "absolute", left: "0", top: y + "px", width: "100%", height: "0",
        borderTop: "3px dashed #A23B2E",
      });
      const lab = document.createElement("div");
      lab.textContent = `↑ average visitor stops scrolling here — ${scrollReachPct}%`;
      Object.assign(lab.style, {
        position: "absolute", left: "8px", top: (y + 6) + "px",
        font: "700 12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif",
        color: "#fff", background: "#A23B2E", padding: "3px 8px", borderRadius: "3px",
      });
      root.appendChild(line); root.appendChild(lab);
    }

    const legend = document.createElement("div");
    legend.innerHTML =
      `<div style="font-weight:700;margin-bottom:4px">${title || "Click heatmap"}</div>` +
      `<div style="display:flex;align-items:center;gap:6px">` +
      `<span>few</span><span style="display:inline-block;width:110px;height:9px;border-radius:5px;` +
      `background:linear-gradient(90deg,rgb(0,90,190),rgb(0,170,140),rgb(225,175,40),rgb(230,110,30),rgb(200,30,30))"></span>` +
      `<span>many</span><span style="opacity:.8">· peak ${max.toLocaleString("en-IN")}</span></div>`;
    Object.assign(legend.style, {
      position: "absolute", left: "8px", top: "8px",
      font: "12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif",
      color: "#fff", background: "rgba(20,24,22,.92)",
      padding: "8px 10px", borderRadius: "6px",
    });
    root.appendChild(legend);

    document.body.appendChild(root);
  }, { spots: enriched, scrollReachPct: opts.scrollReachPct ?? null, title: opts.title ?? null, max });

  return enriched;
}

export async function clearHeatmap(page) {
  await page.evaluate(() => document.getElementById("__cro_heat")?.remove());
}
