// v6.11 time axis acceptance: screenshots at t = 0 / 3 / 6 / 2.5, timeline close-up,
// GPU-vs-CPU blend checks and switch timings (software GL — FPS / ms are NOT representative
// of a real GPU; they are relative numbers on the same machine).
// usage: node scripts/timeline.mjs [baseUrl] [outDir]
import { chromium } from "playwright-core";
import fs from "node:fs";

const argv = process.argv.slice(2);
const base = argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4173/";
const out = argv.find((a) => a.startsWith("/")) ?? "/tmp";
fs.mkdirSync(out, { recursive: true });
const prefix = process.env.PREFIX ?? "three-v6_11";
const gpuFlags = process.env.ATMOS_GPU
  ? ["--use-gl=angle", "--use-angle=vulkan", "--enable-gpu"]
  : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--headless=new", "--no-sandbox", "--ignore-gpu-blocklist", ...gpuFlags],
});
// Timeline close-up (2× device pixels)
const closeCtx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
const close = await closeCtx.newPage();
await close.goto(base + (base.includes("?") ? "&" : "?") + "t=2.5&noBuildings=1", { waitUntil: "networkidle" });
await close.waitForFunction(() => window.__atmosReady === true, null, { timeout: 120_000 });
await close.waitForFunction(() => window.__atmosApi.timeline().ready.every(Boolean), null, { timeout: 120_000 });
await close.evaluate(() => window.__atmosApi.setPlayback({ rate: 2 }));
const tlPath = `${out}/${prefix}-tl-controls.png`;
await close.locator(".timeline").screenshot({ path: tlPath, timeout: 120_000 });
const closeShot = tlPath;
await closeCtx.close();

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__atmosReady === true, null, { timeout: 120_000 });
await page.waitForFunction(() => (window.__atmosStatus?.buildings ?? 0) > 0, null, { timeout: 60_000 }).catch(() => {});
const firstFrame = await page.evaluate(() => window.__atmosApi.timings().firstFrameMs);
// every frame's encoded bytes in the worker cache (background prefetch)
await page.waitForFunction(() => window.__atmosApi.timeline().ready.every(Boolean), null, { timeout: 120_000 });

const frames = (n = 2) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
async function at(t) {
  await page.evaluate((t) => window.__atmosApi.setTime(t), t);
  await page.waitForFunction(() => window.__atmosApi.hasFrame(), null, { timeout: 120_000 });
  await frames(2);
}
async function shot(name) {
  const path = `${out}/${prefix}-${name}.png`;
  await page.screenshot({ path, timeout: 180_000 });
  return path;
}
const report = { firstFrameMs: firstFrame, shots: [closeShot], checks: {}, timings: {} };

// Scene: overview camera, particles + a 100 m horizontal speed slice (fixed colour scale 0–20 m/s).
await page.evaluate(() => {
  const a = window.__atmosApi;
  a.setView("slice");
  a.setSlice({ heightM: 100, variable: "speed", opacity: 0.8, contours: 10 });
  a.setCamera([-14.5, 9, 13.5], [0.5, 0.3, -0.5]);
  a.setParticles({ count: 64000 });
  a.advance(120, 1 / 60);
});
for (const [t, name] of [[0, "tl-f000"], [3, "tl-f003"], [6, "tl-f006"], [2.5, "tl-t2_5"]]) {
  await at(t);
  await page.evaluate(() => window.__atmosApi.advance(20, 1 / 60));
  report.shots.push(await shot(name));
  const info = await page.evaluate(() => ({ tl: window.__atmosApi.timeline(), legend: [...document.querySelectorAll(".legend")].map((e) => e.textContent?.trim()) }));
  report.checks[name] = { t: info.tl.t, clock: info.tl.clock, a: info.tl.a, b: info.tl.b, s: info.tl.s, legend: info.legend };
}
// GPU blend vs CPU blend at t = 2.5 (wind magnitude-preserving, speed slice, scalar)
report.checks.texels = await page.evaluate(() => {
  const a = window.__atmosApi;
  const cells = [[150, 150, 3], [40, 260, 0], [280, 30, 20], [10, 10, 39]];
  return cells.map(([ix, iy, k]) => ({ cell: [ix, iy, k], wind: a.debugTimeTexel("wind", ix, iy, k) }));
});

// Volume (tke) + particles at t = 2.5: the shared "current time" texture
await page.evaluate(() => {
  const a = window.__atmosApi;
  a.setSlice({ enabled: false });
  a.setVolume({ enabled: true, variable: "tke", opacity: 0.7, threshold: 0.15 });
});
await page.waitForFunction(() => window.__atmosApi.debugVisibility().ok && window.__atmosApi.hasFrame(), null, { timeout: 120_000 });
await frames(2);
report.checks.tkeTexel = await page.evaluate(() => window.__atmosApi.debugTimeTexel("tke", 150, 150, 6));
report.checks.tkeCompare = await page.evaluate(() => window.__atmosApi.debugCompare("tke", 150, 150, 6)?.match);
report.shots.push(await shot("tl-volume-t2_5"));

// Probe follows the current time
await page.evaluate(() => {
  const a = window.__atmosApi;
  a.setVolume({ enabled: false });
  a.setView("overview");
  a.probeAt(150, 150);
  a.setProbeVariable("speed");
});
report.checks.probe = [];
for (const t of [0, 3, 6]) {
  await at(t);
  await page.waitForTimeout(300);
  const v = await page.evaluate(() => {
    const el = document.querySelector(".profile-box");
    return el?.textContent?.replace(/\s+/g, " ").slice(0, 160);
  });
  report.checks.probe.push({ t, text: v });
  if (t === 3) report.shots.push(await shot("tl-probe-f003"));
}


// Fixed colour scales across time: section / slice range and legend do not move with t,
// and the ground value-filter handles follow the (growing) data bounds instead of clipping.
report.checks.fixedScale = await page.evaluate(async () => {
  const a = window.__atmosApi;
  const raf = (n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const out = [];
  for (const t of [0, 6]) {
    a.setTime(t);
    while (!a.hasFrame()) await raf(1);
    await raf(4);
    const v = a.debugVisibility();
    const legend = [...document.querySelectorAll(".legend")].map((e) => e.textContent?.replace(/\s+/g, " ").trim());
    const ground = a.status().ground;
    out.push({ t, section: [v.section?.min, v.section?.max], legend, ground });
  }
  return out;
});

// Switch timings: step to a GPU-resident neighbour vs a far frame (slots must be refilled)
report.timings.step = [];
await page.evaluate(() => { const a = window.__atmosApi; a.setProbeEnabled(false); a.setTime(0); });
await page.waitForFunction(() => window.__atmosApi.hasFrame(), null, { timeout: 60_000 });
for (const target of [1, 2, 5, 0, 3, 6]) {
  const ms = await page.evaluate(async (target) => {
    const a = window.__atmosApi;
    const t0 = performance.now();
    a.setTime(target);
    let n = 0;
    while (!a.hasFrame()) { await new Promise((r) => requestAnimationFrame(r)); n += 1; if (n > 2000) break; }
    return { ms: performance.now() - t0, rafFrames: n };
  }, target);
  report.timings.step.push({ to: target, ...ms });
}
// Playback: FPS while playing vs paused, blend cost
report.timings.fps = await page.evaluate(async () => {
  const a = window.__atmosApi;
  const measure = (ms) => new Promise((resolve) => {
    let n = 0; const t0 = performance.now();
    const f = () => { n += 1; if (performance.now() - t0 < ms) requestAnimationFrame(f); else resolve((n * 1000) / (performance.now() - t0)); };
    requestAnimationFrame(f);
  });
  a.setTime(0);
  const paused = await measure(4000);
  a.setPlayback({ rate: 4 });
  a.play();
  const playing = await measure(4000);
  const tl = a.timeline();
  a.pause();
  return { paused, playing, tAfter: tl.t, buffering: tl.buffering, stats: a.timeStats() };
});
report.errors = errors.slice(0, 20);
fs.writeFileSync(`${out}/${prefix}-timeline-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
