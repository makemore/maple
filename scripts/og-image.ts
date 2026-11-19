// Draws Grove's share picture (grove/assets/og.html) and home-screen icon with headless Chrome,
// and writes them into grove/src/images.ts so the function serves them with nothing else to host.
// Run after changing the design: node scripts/og-image.ts (needs Google Chrome, or CHROME=path).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ICON_SVG } from "../kit/pages.ts";

const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const dir = mkdtempSync(join(tmpdir(), "grove-og-"));

function shot(html: string, w: number, h: number) {
  const page = join(dir, `${w}x${h}.html`), out = join(dir, `${w}x${h}.png`);
  writeFileSync(page, html);
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${w},${h}`, `--screenshot=${out}`, `file://${page}`], { stdio: "ignore" });
  return readFileSync(out).toString("base64");
}

const og = shot(readFileSync(resolve("grove/assets/og.html"), "utf8"), 1200, 630);
// The home-screen icon is square with no rounded corners: phones round them themselves.
const touch = shot(`<html><body style="margin:0;width:180px;height:180px;background:#fffdf7">${ICON_SVG.replace(/<rect x="1"[^>]*>/, "").replace('rx="14"', 'rx="0"').replace("<svg ", '<svg width="180" height="180" ')}</body></html>`, 180, 180);

writeFileSync(
  resolve("grove/src/images.ts"),
  `// Made by scripts/og-image.ts from grove/assets/og.html. Don't edit by hand.\n` +
    `export const OG_PNG = Buffer.from(${JSON.stringify(og)}, "base64");\n` +
    `export const TOUCH_ICON_PNG = Buffer.from(${JSON.stringify(touch)}, "base64");\n`,
);
console.log(`og.png ${Math.round((og.length * 3) / 4 / 1024)} KB, apple-touch-icon.png ${Math.round((touch.length * 3) / 4 / 1024)} KB`);
