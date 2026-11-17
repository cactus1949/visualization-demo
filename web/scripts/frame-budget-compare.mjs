// Same camera, variable and UI sliders at two budget rungs.
// SwiftShader. Not a strong-device result and not a GT730 frame rate.
import { chromium } from "playwright-core";
import fs from "node:fs";

const outDir = process.argv[2] ?? "/opt/cursor/artifacts/frame-budget";
fs.mkdirSync(outDir, { recursive: true });
const base = process.argv[3] ?? "http://127.0.0.1:5175/?format=sz3&tab=globe";

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

async function settle(level) {
  return page.evaluate(async (rung) => {
    const atmos = window.__atmosApi;
    const globe = window.__globeApi;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    atmos.setLayer("particles", false);
    atmos.setLayer("buildings", true);
    atmos.setLayer("ground", true);
    atmos.setVolume({ enabled: true, variable: "u_gust", opacity: 2, threshold: 0 });
    atmos.setCuts({ z: [0.27, 1] });
    globe.setExaggeration(10);
    globe.setTerrain(false);
    globe.setView("overview");
    const started = performance.now();
    while (performance.now() - started < 40_000) {
      const info = atmos.frameBudget();
      if (info.volume?.visible && info.volume.renders > 2) break;
      await sleep(250);
    }
    atmos.setBudgetLevel(rung);
    await sleep(900);
    const info = atmos.frameBudget();
    const diag = atmos.diagnostic();
    return {
      rung,
      label: info.label,
      level: info.level,
      knobs: info.knobs,
      volume: info.volume,
      renderer: diag.renderer,
      probe: info.budgetProbe,
    };
  }, level);
}

const low = await settle(1);
await page.screenshot({ path: `${outDir}/volume-rung1-same-ui.png`, timeout: 180_000 });
const high = await settle(4);
await page.screenshot({ path: `${outDir}/volume-rung4-same-ui.png`, timeout: 180_000 });
const report = {
  environment: "swiftshader-not-a-strong-device-and-not-gt730",
  ui: { variable: "u_gust", opacity: 2, threshold: 0, exaggeration: 10, particles: false, zcut: [0.27, 1], view: "overview" },
  low,
  high,
  errors: errors.slice(0, 12),
};
fs.writeFileSync(`${outDir}/volume-compare.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ low: { label: low.label, volume: low.volume, renderer: low.renderer }, high: { label: high.label, volume: high.volume }, errors: report.errors }, null, 2));
await browser.close();
