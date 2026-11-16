// Follow-up shots: volume actually visible (threshold 0), occlusion, camera redraw, context restore.
// SwiftShader. Not a GT730 FPS result.
import { chromium } from "playwright-core";
import fs from "node:fs";

const outDir = process.argv[2] ?? "/opt/cursor/artifacts/frame-budget";
fs.mkdirSync(outDir, { recursive: true });
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
await page.goto("http://127.0.0.1:5173/?format=sz3", { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForFunction(() => window.__atmosReady === true, null, { timeout: 120_000 });
await page.waitForFunction(() => (window.__atmosStatus?.buildings ?? 0) > 0, null, { timeout: 90_000 });

const visual = await page.evaluate(async () => {
  const api = window.__atmosApi;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  api.setBudgetLevel(4);
  api.setLayer("particles", true);
  api.setLayer("buildings", true);
  api.setVolume({ enabled: true, variable: "tke", threshold: 0, opacity: 0.85 });
  api.setView("close");
  let guard = 0;
  while (guard < 80 && !(api.frameBudget().volume?.visible && api.frameBudget().volume.renders > 2)) {
    await sleep(250);
    guard += 1;
  }
  const before = api.frameBudget().volume.renders;
  api.setView("overview");
  await sleep(700);
  const after = api.frameBudget();
  return {
    before,
    afterRenders: after.volume.renders,
    visible: after.volume.visible,
    size: { w: after.volume.width, h: after.volume.height, dw: after.volume.drawingWidth, dh: after.volume.drawingHeight },
    label: after.label,
    particles: after.particles,
    instantsMatch: after.instantsMatch,
    instants: after.instants,
    probe: after.probe,
    fb: api.volumeFramebuffer(),
  };
});
await page.screenshot({ path: `${outDir}/box-volume-occlude-close.png`, timeout: 180_000 });

await page.evaluate(() => {
  const api = window.__atmosApi;
  api.setVolume({ enabled: false });
  api.setLayer("particles", false);
  api.setSection({ variable: "tke", azimuthDeg: 70, offsetKm: -0.2, opacity: 0.45, lowAlpha: true });
  api.setView("section");
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/box-section-translucent.png`, timeout: 180_000 });

const loss = await page.evaluate(async () => {
  const api = window.__atmosApi;
  api.setVolume({ enabled: true, variable: "tke", threshold: 0, opacity: 0.8 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const hasExt = api.loseContextForTest();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const mid = api.frameBudget();
  api.restoreContextForTest();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = api.frameBudget();
  return {
    hasExt,
    mid: { loss: mid.lossCount, restore: mid.restoreCount, notice: mid.notice },
    after: { loss: after.lossCount, restore: after.restoreCount, level: after.level, notice: after.notice, renders: after.volume?.renders, visible: after.volume?.visible },
  };
});
await page.screenshot({ path: `${outDir}/box-after-restore.png`, timeout: 180_000 });

const report = { environment: "swiftshader-not-gt730", visual, loss, errors: errors.slice(0, 20) };
fs.writeFileSync(`${outDir}/visual.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
