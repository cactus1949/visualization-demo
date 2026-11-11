// Headless screenshots of the demo (software WebGL via SwiftShader — FPS is NOT representative).
// usage: node scripts/screenshot.mjs [url] [overview|slice|section|close|embedded|filter|panel|probe-hover|probe-fixed|probe-panel] [out.png]
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const VIEWS = [
  "overview",
  "slice",
  "section",
  "section-volume",
  "section-volume-05",
  "section-volume-02",
  "hslice-volume-05",
  "close",
  "embedded",
  "filter",
  "panel",
  "probe-hover",
  "probe-fixed",
  "probe-panel",
  "v6-xcut-face",
  "v6-xcut-open",
  "v6-ycut",
  "v6-lon-05",
  "v6-lat-1",
  "v6-polyline",
  "v6-boxstack",
  "v6_1-probe-hover",
  "v6_1-probe-fixed",
  "v6_1-probe-near",
  "v6_1-probe-far",
  "v6_1-polyline",
  "v6_1-boxstack",
  "v6_1-lon",
  "v6_2-panel-section",
  "v6_2-height-handle",
  "v6_2-lon-handle",
  "v6_2-polyline-1pt",
  "v6_2-polyline-3pt",
  "v6_2-box-empty",
  "v6_2-box-40",
  "v6_2-box-exag",
  "v6_3-unfolded",
  "v6_3-box-drag",
  "v6_3-particles-1x",
  "v6_3-particles-exag",
];
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
  } else if (["section-volume", "section-volume-05", "section-volume-02"].includes(v)) {
    api.setLayer("particles", false);
    api.setLayer("buildings", true);
    api.setSection({
      variable: "speed",
      azimuthDeg: 90,
      offsetKm: -0.4,
      opacity: v === "section-volume" ? 1 : v === "section-volume-05" ? 0.5 : 0.2,
      contours: 12,
    });
    api.setVolume({
      enabled: true,
      variable: "tke",
      opacity: 0.7,
      threshold: 0.15,
      filterSlices: false,
    });
    api.setCamera([-12.5, 7.2, 11.5], [0.4, 0.8, -0.4]);
  } else if (v === "hslice-volume-05") {
    api.setView("slice");
    api.setLayer("particles", false);
    api.setLayer("buildings", true);
    api.setSlice({ variable: "speed", heightM: 250, opacity: 0.5, contours: 12 });
    api.setVolume({
      enabled: true,
      variable: "tke",
      opacity: 0.7,
      threshold: 0.15,
      filterSlices: false,
    });
    api.setCamera([-12.5, 7.2, 11.5], [0.4, 0.8, -0.4]);
  } else if (v === "close") {
    api.setView("close");
    api.setParticles({ paused: true });
    api.setLayer("particles", false);
    api.setVolume({ enabled: true, variable: "tke", filterSlices: false });
  } else if (v === "embedded") {
    api.setView("close");
    api.setLayer("particles", false);
    api.setLayer("buildings", true);
    // slightly lower opacity so façades stay readable in the close view
    api.setVolume({ enabled: true, variable: "tke", opacity: 0.4, filterSlices: false });
  } else if (v === "filter") {
    api.setView("close");
    api.setLayer("particles", false);
    api.setLayer("buildings", true);
    api.setVolume({
      enabled: true,
      variable: "tke",
      filterMin: 8.5,
      filterMax: 12.5,
      filterSlices: false,
    });
  } else if (v === "panel") {
    api.setView("overview");
    api.setLayer("particles", false);
    api.setVolume({ enabled: true, variable: "tke", filterSlices: false });
  } else if (v === "probe-hover") {
    api.setView("overview");
    api.setLayer("particles", false);
    api.setLayer("buildings", true);
    api.setVolume({ enabled: false });
    api.setProbeEnabled(true);
    api.probeHoverAt(190, 120);
  } else if (v === "probe-fixed") {
    api.setView("overview");
    api.setLayer("particles", false);
    api.setLayer("buildings", true);
    api.setVolume({ enabled: false });
    api.setProbeEnabled(true);
    api.probeAt(140, 170);
    api.probeHoverAt(200, 110);
  } else if (v === "probe-panel") {
    api.setView("overview");
    api.setLayer("particles", false);
    api.setVolume({ enabled: true, variable: "tke", filterSlices: false });
    api.setProbeEnabled(true);
    api.probeAt(150, 160);
  } else if (v === "v6-xcut-face" || v === "v6-xcut-open") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: true, variable: "tke", filterSlices: false });
    api.setCuts({ x: [0.2, 0.7], y: [0, 1], z: [0, 1], faces: v === "v6-xcut-face" });
    api.setCamera([-16, 6.5, 4.5], [0.5, 0.5, 0]);
  } else if (v === "v6-ycut") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: true, variable: "tke" });
    api.setCuts({ y: [0.25, 0.75], faces: true });
    api.setCamera([-12.5, 7.2, 11.5], [0.4, 0.6, -0.4]);
  } else if (v === "v6-lon-05" || v === "v6-lat-1") {
    api.setLayer("particles", false);
    api.setSectionMode(v === "v6-lon-05" ? "lon" : "lat");
    api.setSection({ variable: "speed", offsetKm: -1.0, opacity: v === "v6-lon-05" ? 0.5 : 1 });
    api.setVolume({ enabled: true, variable: "tke" });
    api.setCamera(v === "v6-lon-05" ? [-14, 5.5, 2] : [-2, 5.5, 15], [0.4, 0.7, -0.4]);
  } else if (v === "v6-polyline") {
    api.setLayer("particles", false);
    api.setSectionMode("polyline");
    api.setPolyline([{ x: -6, z: -5 }, { x: -1, z: 1 }, { x: 5, z: 4 }]);
    api.setSection({ variable: "speed", opacity: 0.85 });
    api.setCamera([-8, 5.2, 14], [0, 0.6, 0]);
  } else if (v === "v6-boxstack") {
    api.setLayer("particles", false);
    api.setSectionMode("box");
    api.setBox({ x0: -4, z0: -3, x1: 4, z1: 3, heightMinM: 100, heightMaxM: 350, stepLevels: 2, stretch: 2.2, spacingKm: 0.22 });
    api.setSection({ opacity: 0.75 });
    api.setCamera([-13, 5.8, 10], [0, 0.8, 0]);
  } else if (v === "v6_1-probe-hover") {
    api.setView("overview");
    api.setLayer("particles", false);
    api.setLayer("buildings", true);
    api.setVolume({ enabled: false });
    api.setExaggeration(3);
    api.setProbeEnabled(true);
    api.probeHoverAt(190, 120);
  } else if (v === "v6_1-probe-fixed" || v === "v6_1-probe-near" || v === "v6_1-probe-far") {
    api.setView("overview");
    api.setLayer("particles", false);
    api.setLayer("buildings", true);
    api.setVolume({ enabled: false });
    api.setExaggeration(3);
    api.setProbeEnabled(true);
    api.probeAt(140, 170);
    if (v === "v6_1-probe-fixed") api.probeHoverAt(200, 110);
    // cell (140,170) is about (-0.57, -1.23) km in root-local xz; stem goes to y=1 km * 3.
    if (v === "v6_1-probe-near") api.setCamera([-2.6, 2.2, 1.4], [-0.57, 0.7, -1.23]);
    if (v === "v6_1-probe-far") api.setCamera([-28, 18, 26], [0, 0.6, 0]);
  } else if (v === "v6_1-polyline") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: false });
    api.setSectionMode("polyline");
    api.setPolyline([{ x: -6, z: -5 }, { x: -1, z: 1 }, { x: 5, z: 4 }]);
    api.setSection({ variable: "speed", opacity: 0.85 });
    api.selectPolylineVertex(1);
    api.setCamera([-12, 7.2, 16], [-1.0, 0.5, -0.5]);
  } else if (v === "v6_1-boxstack") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: false });
    api.setSectionMode("box");
    api.setBox({ x0: -4, z0: -3, x1: 4, z1: 3, heightMinM: 100, heightMaxM: 350, stepLevels: 2, stretch: 2.2, spacingKm: 0.22 });
    api.setSection({ opacity: 0.75 });
    api.setCamera([-13, 5.8, 10], [0, 0.8, 0]);
  } else if (v === "v6_1-lon") {
    api.setLayer("particles", false);
    api.setSectionMode("lon");
    api.setSection({ variable: "speed", offsetKm: -1.0, opacity: 0.5 });
    api.setVolume({ enabled: true, variable: "tke" });
    api.setCamera([-14, 5.5, 2], [0.4, 0.7, -0.4]);
  } else if (v === "v6_2-panel-section") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: false });
    api.setSectionMode("polyline");
  } else if (v === "v6_2-height-handle") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: false });
    api.setExaggeration(3);
    api.setSlice({ variable: "speed", heightM: 250, opacity: 0.85, contours: 12 });
    api.setCamera([-8, 6.5, 12], [6, 0.8, 0]);
  } else if (v === "v6_2-lon-handle") {
    api.setLayer("particles", false);
    api.setSectionMode("lon");
    api.setSection({ variable: "speed", offsetKm: -1.0, opacity: 0.6, contours: 12 });
    api.setVolume({ enabled: true, variable: "tke", opacity: 0.6 });
    api.setExaggeration(3);
    api.setCamera([-14, 5.5, 2], [0.4, 1.0, -0.4]);
  } else if (v === "v6_2-polyline-1pt") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: false });
    api.setExaggeration(3);
    api.setPolyline([{ x: -2, z: 1 }]);
    api.setSection({ variable: "speed" });
    api.setCamera([-8, 5.5, 12], [-2, 0.3, 1]);
  } else if (v === "v6_2-polyline-3pt") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: false });
    api.setExaggeration(3);
    api.setPolyline([{ x: -6, z: -5 }, { x: -1, z: 1 }, { x: 5, z: 4 }]);
    api.setSection({ variable: "speed", opacity: 0.85 });
    api.selectPolylineVertex(1);
    api.setCamera([-8, 5.2, 14], [0, 0.6, 0]);
  } else if (v === "v6_2-box-empty") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: true, variable: "tke" });
    api.setExaggeration(3);
    api.setPolyline([{ x: -6, z: -5 }, { x: -1, z: 1 }, { x: 5, z: 4 }]);
    api.setSectionMode("box");
    api.setCamera([-13, 8, 12], [0, 0.4, 0]);
  } else if (v === "v6_2-box-40" || v === "v6_2-box-exag") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: true, variable: "tke" });
    api.setExaggeration(v === "v6_2-box-exag" ? 3 : 1);
    api.setSectionMode("box");
    api.setBox({ x0: -4, z0: -3, x1: 4, z1: 3, heightMinM: 0, heightMaxM: 1000, stepLevels: 1, defined: true });
    api.setSection({ variable: "speed", opacity: 0.75 });
    api.setCamera(v === "v6_2-box-exag" ? [-7.5, 3.6, 9.5] : [-6.5, 1.7, 8.5], [0, v === "v6_2-box-exag" ? 1.2 : 0.45, 0]);
  } else if (v === "v6_3-unfolded") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: false });
    api.setExaggeration(3);
    api.setPolyline([{ x: -6, z: -5 }, { x: -1, z: 1 }, { x: 5, z: 4 }]);
    api.setSection({ variable: "tke", opacity: 0.85 });
    api.selectPolylineVertex(1);
    api.setCamera([-8, 5.2, 14], [0, 0.6, 0]);
  } else if (v === "v6_3-box-drag") {
    api.setLayer("particles", false);
    api.setVolume({ enabled: false });
    api.setExaggeration(3);
    // Plant height + lon grips first, then switch to box: leftover grips must disappear.
    api.setSlice({ variable: "speed", heightM: 250, opacity: 0.85, contours: 12 });
    api.setSectionMode("lon");
    api.setSection({ variable: "speed", offsetKm: -1.0, opacity: 0.6 });
    api.setSectionMode("box");
    api.setCamera([0, 18, 0.2], [0, 0, 0]);
  } else if (v === "v6_3-particles-1x" || v === "v6_3-particles-exag") {
    const hi = v === "v6_3-particles-exag";
    api.setLayer("particles", true);
    api.setLayer("buildings", true);
    api.setVolume({ enabled: false });
    api.setExaggeration(hi ? 8 : 1);
    api.setSectionMode("box");
    api.setBox({ x0: -3.2, z0: -2.4, x1: 3.2, z1: 2.4, heightMinM: 0, heightMaxM: 1000, stepLevels: 4, defined: true });
    api.setSection({ variable: "speed", opacity: 0.55 });
    api.setCamera(hi ? [-8.5, 5.2, 11] : [-8.5, 2.2, 11], [0, hi ? 1.6 : 0.35, 0]);
  } else {
    api.setView("overview");
  }
}, view);
if (
  [
    "embedded",
    "filter",
    "panel",
    "probe-panel",
    "close",
    "section-volume",
    "section-volume-05",
    "section-volume-02",
    "hslice-volume-05",
    "v6-xcut-face",
    "v6-xcut-open",
    "v6-ycut",
    "v6-lon-05",
    "v6-lat-1",
    "v6_1-lon",
    "v6_2-lon-handle",
  ].includes(view)
) {
  await page.waitForFunction(() => window.__atmosStatus?.volume === "tke", null, {
    timeout: 90_000,
  });
}
if (
  [
    "v6-boxstack",
    "v6-polyline",
    "v6_1-boxstack",
    "v6_1-polyline",
    "v6_2-panel-section",
    "v6_2-polyline-1pt",
    "v6_2-polyline-3pt",
    "v6_2-box-empty",
    "v6_2-box-40",
    "v6_2-box-exag",
    "v6_2-height-handle",
    "v6_2-lon-handle",
    "v6_3-unfolded",
    "v6_3-box-drag",
    "v6_3-particles-1x",
    "v6_3-particles-exag",
  ].includes(view)
) {
  await page.evaluate(() => {
    const details = [...document.querySelectorAll("details")].find((d) => {
      const text = d.querySelector("summary")?.textContent ?? "";
      return text.includes("剖面") || text.includes("垂直剖面") || text.includes("水平切片");
    });
    details?.setAttribute("open", "");
    details?.scrollIntoView({ block: "start" });
  });
}
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
let gripInfo = null;
if (view === "v6_3-box-drag") {
  const canvas = page.locator("canvas.canvas");
  const box = await canvas.boundingBox();
  if (box) {
    const x0 = box.x + box.width * 0.38;
    const y0 = box.y + box.height * 0.42;
    const x1 = box.x + box.width * 0.62;
    const y1 = box.y + box.height * 0.62;
    await page.mouse.move(x0, y0);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 12 });
    await page.waitForTimeout(400);
  }
  gripInfo = await page.evaluate(() => {
    const grips = [...document.querySelectorAll(".anno-grip")];
    const visible = grips.filter((el) => !el.classList.contains("anno-hidden") && el.style.display !== "none");
    return {
      total: grips.length,
      visible: visible.length,
      icons: visible.map((el) => el.textContent?.trim() ?? ""),
    };
  });
}
if (view === "v6_2-panel-section") {
  const panel = page.locator(".panel");
  await panel.evaluate((el) => {
    for (const d of el.querySelectorAll("details")) {
      const text = d.querySelector("summary")?.textContent ?? "";
      if (text.includes("剖面") && !text.includes("粒子")) d.setAttribute("open", "");
      else d.removeAttribute("open");
    }
    el.scrollTop = 0;
  });
  await page.waitForTimeout(400);
  await panel.screenshot({ path: output, timeout: 120_000 });
} else {
  await page.screenshot({ path: output, timeout: 120_000 });
}
console.log(
  JSON.stringify({
    view,
    output,
    status,
    particleMoved: before.some((v, i) => Math.abs(v - after[i]) > 1e-6),
    particleSampleBefore: before,
    particleSampleAfter: after,
    gripInfo,
    consoleErrors: consoleErrors.slice(0, 10),
  }),
);
await browser.close();
