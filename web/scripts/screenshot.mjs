// Headless screenshots of the demo (software WebGL via SwiftShader — FPS is NOT representative).
// usage: node scripts/screenshot.mjs [url] [overview|slice|section|close|panel] [out.png]
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const VIEWS = ["overview", "slice", "section", "close", "panel"];
const view = args.find((a) => VIEWS.includes(a)) ?? "overview";
const output = args.find((a) => a.endsWith(".png")) ?? `/tmp/atmos-${view}.png`;
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:4173/";
const gpuFlags = process.env.ATMOS_GPU
  ? ["--use-gl=angle", "--use-angle=vulkan", "--enable-gpu"]
  : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--headless=new", "--no-sandbox", "--ignore-gpu-blocklist", ...gpuFlags],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    consoleErrors.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__atmosReady === true, null, { timeout: 90_000 });
// wait for buildings
await page
  .waitForFunction(() => (window.__atmosStatus?.buildings ?? 0) > 0, null, { timeout: 60_000 })
  .catch(() => {});

await page.evaluate((v) => {
  const api = window.__atmosApi;
  if (v === "slice") {
    api.setView("slice");
    api.setSlice({ heightM: 120, variable: "speed" });
    api.setLayer("particles", false);
  } else if (v === "section") {
    api.setView("section");
    api.setSection({ variable: "speed", azimuthDeg: 75, offsetKm: -1.2 });
    api.probeAt(150, 160);
  } else if (v === "close") {
    api.setView("close");
  } else if (v === "panel") {
    api.setView("overview");
    api.setSection({ variable: "w", azimuthDeg: 110, offsetKm: 1.5 });
    api.probeAt(140, 150);
  } else {
    api.setView("overview");
  }
}, view);
await page.waitForTimeout(1500);
// software GL renders ~1 fps: pre-run 40 simulation steps so trails are fully grown
await page.evaluate(() => {
  window.__atmosApi.advance(70, 1 / 60);
  window.__atmosApi.setParticles({ paused: true }); // freeze at a representative 60 fps state
});
await page.waitForTimeout(1500);
const before = await page.evaluate(() => window.__atmosApi.sampleParticle());
await page.evaluate(() => window.__atmosApi.advance(3, 1 / 60));
const after = await page.evaluate(() => window.__atmosApi.sampleParticle());
await page.waitForTimeout(2500);
const status = await page.evaluate(() => window.__atmosApi.status());
await page.screenshot({ path: output });
console.log(
  JSON.stringify({
    view,
    output,
    status,
    particleMoved: before.some((v, i) => Math.abs(v - after[i]) > 1e-6),
    particleSampleBefore: before,
    particleSampleAfter: after,
    consoleErrors: consoleErrors.slice(0, 10),
  }),
);
await browser.close();
