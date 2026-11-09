#!/usr/bin/env bun
/**
 * Renders the PWA's raster icons and iOS launch images from public/icon.svg,
 * with the Playwright Chromium the app already depends on:
 *
 *   bun scripts/render-icons.ts
 *
 * Writes public/icons/: icon-192.png and icon-512.png (rounded, "any"),
 * maskable-192.png and maskable-512.png (full bleed, the mark inside the
 * maskable safe zone), and startup-<w>x<h>-<light|dark>.png for current
 * iPhones, which iOS shows while an installed app launches. The colors are the
 * page surfaces from tokens.css, so launch blends into the first frame.
 * Re-run after changing icon.svg or those colors, and commit the output.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "public");
const out = join(root, "icons");
mkdirSync(out, { recursive: true });

const svg = readFileSync(join(root, "icon.svg"), "utf8");
// Full bleed for maskable icons: the launcher applies its own mask shape.
const maskable = svg.replace(/<rect([^>]*?) rx="\d+"/, "<rect$1");
if (maskable === svg) throw new Error("icon.svg: expected a rounded <rect> to flatten");

/** iPhone portrait screens in CSS pixels, with their device pixel ratio. */
const STARTUP_SCREENS = [
  { width: 375, height: 812, dpr: 3 },  // X, XS, 11 Pro, 12 mini, 13 mini
  { width: 414, height: 896, dpr: 2 },  // XR, 11
  { width: 390, height: 844, dpr: 3 },  // 12, 13, 14
  { width: 393, height: 852, dpr: 3 },  // 14 Pro, 15, 15 Pro, 16
  { width: 402, height: 874, dpr: 3 },  // 16 Pro
  { width: 428, height: 926, dpr: 3 },  // 12 Pro Max, 13 Pro Max, 14 Plus
  { width: 430, height: 932, dpr: 3 },  // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  { width: 440, height: 956, dpr: 3 },  // 16 Pro Max
];
const SURFACES = { light: "#f3f2ed", dark: "#141b20" };

const page = (body: string, background = "transparent") =>
  `<!doctype html><html><body style="margin:0;background:${background};display:grid;place-items:center;height:100vh">${body}</body></html>`;
const sized = (markup: string, size: number) => markup.replace("<svg ", `<svg width="${size}" height="${size}" `);

const browser = await chromium.launch();
try {
  for (const size of [192, 512]) {
    const ctx = await browser.newContext({ viewport: { width: size, height: size } });
    const tab = await ctx.newPage();
    await tab.setContent(page(sized(svg, size)));
    await tab.screenshot({ path: join(out, `icon-${size}.png`), omitBackground: true });
    await tab.setContent(page(sized(maskable, size)));
    await tab.screenshot({ path: join(out, `maskable-${size}.png`) });
    await ctx.close();
  }
  for (const screen of STARTUP_SCREENS) {
    const ctx = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, deviceScaleFactor: screen.dpr });
    const tab = await ctx.newPage();
    for (const [scheme, color] of Object.entries(SURFACES)) {
      await tab.setContent(page(sized(svg, 96), color));
      await tab.screenshot({ path: join(out, `startup-${screen.width * screen.dpr}x${screen.height * screen.dpr}-${scheme}.png`) });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`wrote ${out}`);
