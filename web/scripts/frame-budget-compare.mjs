// Same camera and UI at two budget rungs, then the low view.
// Waits until the canvas width matches clientWidth * resolutionScale and the volume
// target matches that canvas. SwiftShader only. Not a GT730 or a strong-GPU result.
import { chromium } from "playwright-core";
import fs from "node:fs";

const outDir = process.argv[2] ?? "/opt/cursor/artifacts/frame-budget";
fs.mkdirSync(outDir, { recursive: true });
const base = process.argv[3] ?? "http://127.0.0.1:5178/?format=sz3&tab=globe&devBasemap=esri";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--headless=new", "--no-sandbox", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 180_000 });
await page.waitForFunction(() => window.__globeReady === true && window.__atmosReady === true, null, { timeout: 180_000 });
await page.waitForFunction(() => (window.__atmosStatus?.buildings ?? 0) > 0, null, { timeout: 180_000 });

async function prepare(view) {
  await page.evaluate(async (name) => {
    const atmos = window.__atmosApi;
    const globe = window.__globeApi;
    atmos.setLayer("particles", false);
    atmos.setLayer("buildings", true);
    atmos.setLayer("ground", true);
    atmos.setVolume({ enabled: true, variable: "u_gust", opacity: 2, threshold: 0 });
    atmos.setCuts({ z: [0.27, 1] });
    globe.setExaggeration(10);
    globe.setTerrain(false);
    globe.setView(name);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const started = performance.now();
    while (performance.now() - started < 40_000) {
      const info = atmos.frameBudget();
      if (info.volume?.visible && info.volume.renders > 2) return;
      await sleep(250);
    }
  }, view);
}

async function holdRung(rung) {
  return page.evaluate(async (level) => {
    const atmos = window.__atmosApi;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let previous = "";
    let stable = 0;
    let last = null;
    for (let i = 0; i < 40; i += 1) {
      const before = atmos.frameBudget();
      if (before.level !== level || before.knobs.volumeSteps !== [24, 32, 48, 80, 128][level]) atmos.setBudgetLevel(level);
      await sleep(250);
      const canvas = document.querySelector("canvas");
      const now = atmos.frameBudget();
      const expectedW = Math.round(canvas.clientWidth * now.knobs.cesiumResolutionScale);
      const expectedH = Math.round(canvas.clientHeight * now.knobs.cesiumResolutionScale);
      const expectVolW = Math.max(1, Math.round(canvas.width * now.knobs.volumeScale));
      const expectVolH = Math.max(1, Math.round(canvas.height * now.knobs.volumeScale));
      const sizeOk = canvas.width === expectedW && canvas.height === expectedH;
      const volOk = Boolean(now.volume?.visible) && Math.abs(now.volume.width - expectVolW) <= 1 && Math.abs(now.volume.height - expectVolH) <= 1;
      const key = `${canvas.width}x${canvas.height}:${now.volume?.width}x${now.volume?.height}:${now.level}`;
      stable = sizeOk && volOk && now.level === level && key === previous ? stable + 1 : 0;
      previous = key;
      last = {
        timeout: false,
        label: now.label,
        level: now.level,
        knobs: now.knobs,
        volume: now.volume,
        framebuffer: {
          width: canvas.width,
          height: canvas.height,
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
          expectedWidth: expectedW,
          expectedHeight: expectedH,
          sizeOk,
          volumeOk: volOk,
        },
      };
      if (stable >= 2) return last;
    }
    return { ...last, timeout: true };
  }, rung);
}

await prepare("overview");
const camera = await page.evaluate(() => {
  const atmos = window.__atmosApi;
  const globe = window.__globeApi;
  atmos.setBudgetLevel(3);
  const before = atmos.frameBudget().level;
  globe.setView("overview");
  const after = atmos.frameBudget().level;
  return { before, after };
});
const low = await holdRung(1);
if (low.timeout || !low.framebuffer.sizeOk) throw new Error(`rung 1 framebuffer did not settle ${JSON.stringify(low.framebuffer)}`);
await page.screenshot({ path: `${outDir}/volume-rung1-same-ui.png`, timeout: 180_000 });
const high = await holdRung(4);
if (high.timeout || !high.framebuffer.sizeOk) throw new Error(`rung 4 framebuffer did not settle ${JSON.stringify(high.framebuffer)}`);
await page.screenshot({ path: `${outDir}/volume-rung4-same-ui.png`, timeout: 180_000 });

await page.evaluate(() => window.__globeApi.setView("low"));
const lowView = await holdRung(4);
await page.screenshot({ path: `${outDir}/low-view-volume-on.png`, timeout: 180_000 });
await page.evaluate(() => window.__atmosApi.setVolume({ enabled: false }));
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/low-view-volume-off.png`, timeout: 180_000 });

const renderer = await page.evaluate(() => window.__atmosApi.diagnostic().renderer);
const report = {
  environment: "swiftshader-not-a-strong-device-and-not-gt730",
  renderer,
  ui: { variable: "u_gust", opacity: 2, threshold: 0, exaggeration: 10, particles: false, zcut: [0.27, 1], view: "overview", basemap: "esri-dev" },
  cameraJumpKeepsLevel: camera,
  low,
  high,
  lowView,
  errors: errors.slice(0, 12),
};
fs.writeFileSync(`${outDir}/volume-compare.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  camera,
  renderer,
  low: { label: low.label, framebuffer: low.framebuffer, volume: low.volume },
  high: { label: high.label, framebuffer: high.framebuffer, volume: high.volume },
  lowView: { timeout: lowView.timeout, framebuffer: lowView.framebuffer, label: lowView.label },
  errors: report.errors,
}, null, 2));
await browser.close();
