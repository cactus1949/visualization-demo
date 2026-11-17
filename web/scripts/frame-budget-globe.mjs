// Globe combo after the third pass: ground wind + buildings + volume, DEM still not requested.
// SwiftShader. Not a GT730 FPS result.
import { chromium } from "playwright-core";
import fs from "node:fs";

const outDir = process.argv[2] ?? "/opt/cursor/artifacts/frame-budget";
fs.mkdirSync(outDir, { recursive: true });
const base = process.argv[3] ?? "http://127.0.0.1:5173/?format=sz3&tab=globe";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--headless=new", "--no-sandbox", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("tianditu") && !message.text().includes("CORS")) errors.push(message.text());
});
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 180_000 });
await page.waitForFunction(() => window.__globeReady === true && window.__atmosReady === true, null, { timeout: 180_000 });
await page.waitForFunction(() => (window.__atmosStatus?.buildings ?? 0) > 0, null, { timeout: 180_000 });

const beforeDem = await page.evaluate(async () => {
  const atmos = window.__atmosApi;
  const globe = window.__globeApi;
  atmos.setLayer("ground", true);
  atmos.setLayer("buildings", true);
  atmos.setLayer("particles", true);
  atmos.setVolume({ enabled: true, variable: "u_gust", threshold: 0, opacity: 0.55 });
  globe.setView("corner");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const resources = performance.getEntriesByType("resource");
  const diag = atmos.diagnostic();
  return {
    terrain: globe.status(),
    demRequested: resources.some((entry) => entry.name.includes("dem.u16")),
    groundRequested: resources.some((entry) => entry.name.includes("ground.u16")),
    resources: resources
      .filter((entry) => /dem\.u16|ground\.u16|buildings\.glb|sz3_O3|GlobeViewer|geo\.json/.test(entry.name))
      .map((entry) => ({ name: entry.name.replace(/^https?:\/\/[^/]+/, ""), durationMs: Math.round(entry.duration) })),
    budget: diag.budget,
    volume: diag.volume,
    buildingTriangles: diag.buildingTriangles,
    depth: diag.cpuSubmitMs,
  };
});
await page.screenshot({ path: `${outDir}/globe-ground-buildings-volume.png`, timeout: 180_000 });

const afterDem = await page.evaluate(async () => {
  const atmos = window.__atmosApi;
  const globe = window.__globeApi;
  globe.setTerrain(true);
  const started = performance.now();
  let loaded = false;
  while (performance.now() - started < 60_000) {
    const status = globe.status();
    if (status.demLoaded) {
      loaded = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  globe.setView("low");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const resources = performance.getEntriesByType("resource");
  return {
    loaded,
    terrain: globe.status(),
    demRequested: resources.some((entry) => entry.name.includes("dem.u16")),
    budget: atmos.frameBudget().label,
    depth: atmos.diagnostic().cpuSubmitMs,
  };
});
await page.screenshot({ path: `${outDir}/globe-terrain-on-low.png`, timeout: 180_000 });

const report = {
  environment: "swiftshader-not-gt730",
  note: "Correctness and relative cost only. Not a GT730 frame rate.",
  beforeDem,
  afterDem,
  errors: errors.slice(0, 20),
};
fs.writeFileSync(`${outDir}/globe-combo.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ beforeDem: { demRequested: beforeDem.demRequested, groundRequested: beforeDem.groundRequested, triangles: beforeDem.buildingTriangles, volume: beforeDem.volume, depth: beforeDem.depth, resources: beforeDem.resources }, afterDem, errors: report.errors }, null, 2));
await browser.close();
