/**
 * Downscales capture PNGs to web-sized JPEGs and injects them as data URIs into
 * a report template, replacing <!--__IMG:key__--> placeholders.
 *
 * Runs the resize inside Chromium via canvas so there's no native image
 * dependency, and writes the base64 straight to disk — it never passes through
 * the agent's context, which would cost ~100k tokens for a handful of images.
 *
 * Usage: node embed-images.js <template.html> <output.html>
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CAPS = path.join(ROOT, "reports", "captures");

const IMAGES = {
  gate_mobile:    { file: "gate-3-after_checkout_click-mobile.png",  width: 420, quality: 0.78 },
  gate_desktop:   { file: "gate-3-after_checkout_click-desktop.png", width: 900, quality: 0.74 },
  pdp_takeover:   { file: "overlay-pdp-mobile.png",                  width: 420, quality: 0.78 },
  plp_takeover:   { file: "overlay-plp-mobile.png",                  width: 420, quality: 0.78 },
  heat_home:      { file: "heatmap-home-mobile.png",                 width: 340, quality: 0.68 },
  heat_plp:       { file: "heatmap-plp-mobile.png",                  width: 340, quality: 0.68 },
  heat_pdp:       { file: "heatmap-pdp-mobile.png",                  width: 340, quality: 0.68 },
  cart_mobile:    { file: "overlay-cart-mobile.png",                 width: 420, quality: 0.78 },
};

const [tplPath, outPath] = process.argv.slice(2);
if (!tplPath || !outPath) { console.error("usage: node embed-images.js <template> <output>"); process.exit(1); }

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();

const dataUris = {};
for (const [key, cfg] of Object.entries(IMAGES)) {
  const abs = path.join(CAPS, cfg.file);
  try {
    // Read bytes in Node and hand the page a data URI. An <img> pointing at a
    // file:// URL is blocked from an about:blank (opaque) origin, and would also
    // taint the canvas — a data URI avoids both.
    const srcUri = "data:image/png;base64," + (await readFile(abs)).toString("base64");
    const uri = await page.evaluate(async ({ src, width, quality }) => {
      const img = new Image();
      img.src = src;
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("load failed")); });
      const scale = Math.min(1, width / img.naturalWidth);
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", quality);
    }, { src: srcUri, width: cfg.width, quality: cfg.quality });
    dataUris[key] = uri;
    process.stderr.write(`  ${key.padEnd(14)} ${(uri.length / 1024).toFixed(0)} KB\n`);
  } catch (e) {
    dataUris[key] = null;
    process.stderr.write(`  ${key.padEnd(14)} FAILED (${cfg.file}): ${e.message}\n`);
  }
}
await browser.close();

let html = await readFile(tplPath, "utf8");
let injected = 0, missing = [];
for (const [key, uri] of Object.entries(dataUris)) {
  const token = `<!--__IMG:${key}__-->`;
  if (!html.includes(token)) continue;
  if (!uri) { missing.push(key); continue; }
  html = html.split(token).join(uri);
  injected++;
}
const leftover = [...html.matchAll(/<!--__IMG:(\w+)__-->/g)].map(m => m[1]);
await writeFile(outPath, html, "utf8");

process.stderr.write(`\ninjected ${injected} images -> ${path.relative(ROOT, outPath)} (${(html.length / 1024).toFixed(0)} KB)\n`);
if (missing.length)  process.stderr.write(`resize failed: ${missing.join(", ")}\n`);
if (leftover.length) process.stderr.write(`UNREPLACED placeholders: ${[...new Set(leftover)].join(", ")}\n`);
