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
  ].includes(view)
) {
  await page.waitForFunction(() => window.__atmosStatus?.volume === "tke", null, {
    timeout: 90_000,
  });
}
if (["v6-boxstack", "v6-polyline"].includes(view)) {
  await page.evaluate(() => {
    const details = [...document.querySelectorAll("details")].find((d) =>
      d.querySelector("summary")?.textContent?.includes("垂直剖面"),
    );
    details?.setAttribute("open", "");
    details?.scrollIntoView({ block: "center" });
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
await page.screenshot({ path: output, timeout: 120_000 });
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
