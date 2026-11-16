// Repeatable frame-budget check. Prints p50/p95/p99, the share of frames slower than 33.3 ms,
// transition spikes and context-loss counts. The WebGL renderer string is part of the result:
// SwiftShader (the default here) is NOT a GT730 measurement, and a run that stays up is not a 30 FPS pass.
//
// usage: node scripts/frame-budget-check.mjs [baseUrl] [outDir]
// GT730: open Chrome on that machine and point baseUrl at the page under test. Do not reuse a SwiftShader JSON.
import { chromium } from "playwright-core";
import fs from "node:fs";

const argv = process.argv.slice(2);
const base = argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:5173/?format=sz3";
const outDir = argv.find((a) => !a.startsWith("http")) ?? "/tmp/frame-budget-check";
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--headless=new", "--no-sandbox", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

async function ready() {
  await page.waitForFunction(() => window.__atmosReady === true, null, { timeout: 120_000 });
  await page.waitForFunction(() => (window.__atmosStatus?.buildings ?? 0) > 0, null, { timeout: 90_000 }).catch(() => {});
  await page.waitForFunction(() => window.__atmosApi?.frameBudget, null, { timeout: 30_000 });
}

function shot(name) {
  return page.screenshot({ path: `${outDir}/${name}.png`, timeout: 180_000 });
}

const boxUrl = new URL(base);
if (!boxUrl.searchParams.get("format")) boxUrl.searchParams.set("format", "sz3");
boxUrl.searchParams.delete("tab");
await page.goto(boxUrl.href, { waitUntil: "domcontentloaded", timeout: 120_000 });
await ready();

const renderer = await page.evaluate(() => {
  const gl = document.querySelector("canvas")?.getContext("webgl2");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  return info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
});

const level0 = await page.evaluate(async () => {
  const api = window.__atmosApi;
  api.setBudgetLevel(0);
  api.setLayer("buildings", true);
  api.setLayer("particles", true);
  api.setVolume({ enabled: true, variable: "tke" });
  api.setLayer("section", false);
  const before = api.frameBudget().volume.renders;
  api.setCamera([-8, 6, 14], [0, 0.4, 0]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const afterMove = api.frameBudget();
    const countLabel = [...document.querySelectorAll("label")].find((el) => el.textContent.includes("粒子数量"));
    const countInput = countLabel?.querySelector("input");
    return {
    before,
    after: afterMove.volume.renders,
    label: afterMove.label,
    particles: afterMove.particles,
    stats: afterMove.stats,
    spikes: afterMove.spikes,
    instantsMatch: afterMove.instantsMatch,
    instants: afterMove.instants,
    probe: afterMove.probe,
    volume: afterMove.volume,
    framebuffer: api.volumeFramebuffer(),
    sliderCount: countInput ? countInput.value : null,
  };
});
await shot("box-volume-buildings-level0");

await page.evaluate(() => window.__atmosApi.setBudgetLevel(4));
await page.waitForTimeout(400);
await shot("box-volume-buildings-level4");

await page.evaluate(() => {
  const api = window.__atmosApi;
  api.setVolume({ enabled: false });
  api.setLayer("particles", false);
  api.setSection({ variable: "tke", azimuthDeg: 90, offsetKm: 0, opacity: 0.35, lowAlpha: true });
});
await page.waitForTimeout(400);
await shot("box-section-transparent");

const loss = await page.evaluate(async () => {
  const api = window.__atmosApi;
  api.setVolume({ enabled: true, variable: "tke" });
  const before = api.frameBudget();
  const lost = api.loseContextForTest();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const mid = api.frameBudget();
  const restored = api.restoreContextForTest();
  await new Promise((resolve) => setTimeout(resolve, 800));
  const after = api.frameBudget();
  return { lost, restored, before: { loss: before.lossCount, level: before.level }, mid, after: { loss: after.lossCount, restore: after.restoreCount, level: after.level, notice: after.notice } };
});

const globeUrl = new URL(boxUrl.href);
globeUrl.searchParams.set("tab", "globe");
await page.goto(globeUrl.href, { waitUntil: "domcontentloaded", timeout: 120_000 });
let globe = null;
if (page.url().includes("tab=globe")) {
  await ready().catch(() => {});
  globe = await page.evaluate(async () => {
    const api = window.__globeApi;
    const atmos = window.__atmosApi;
    if (!api || !atmos) return { missing: true };
    atmos.setTheme("dark");
    api.setView("top");
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { theme: "dark", view: "top", budget: atmos.frameBudget().label };
  }).catch((error) => ({ error: String(error) }));
  await shot("globe-nadir-dark");
  await page.evaluate(() => window.__atmosApi?.setTheme?.("light"));
  await page.waitForTimeout(500);
  await shot("globe-nadir-light");
  await page.evaluate(() => window.__globeApi?.setView?.("corner"));
  await page.waitForTimeout(700);
  await shot("globe-corner");
}

const report = {
  environment: "not-gt730",
  renderer,
  base,
  note: "30 FPS is an acceptance target. This file does not certify it. SwiftShader or any cloud GPU is a separate environment from the GT730 machine.",
  level0,
  loss,
  globe,
  consoleErrors: consoleErrors.slice(0, 30),
};
fs.writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
