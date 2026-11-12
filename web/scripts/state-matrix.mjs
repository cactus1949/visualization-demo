// v6.10 state audit: drives the viewer through toggle orders (debug API + real mouse)
// and asserts that something is visible / the interaction state is consistent.
// Usage: node scripts/state-matrix.mjs [baseUrl] [outDir]
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const base = argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4173/";
const outDir = argv.find((a) => a.startsWith("/")) ?? "/tmp";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--headless=new", "--no-sandbox", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__atmosReady === true, null, { timeout: 90_000 });

const api = (fn, arg) => page.evaluate(fn, arg);
const frames = (n = 3) => page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
async function settle(names = []) {
  for (const n of names) await page.waitForFunction((n) => window.__atmosApi.hasData(n), n, { timeout: 120_000 });
  await frames(3);
}
const results = [];
async function check(name, extra) {
  const vis = await api(() => window.__atmosApi.debugVisibility());
  const st = await api(() => window.__atmosApi.interactionState());
  let ok = vis.ok;
  let why = vis.reasons.join(",");
  if (extra) {
    const r = extra(vis, st);
    if (r !== true) { ok = false; why = [why, r].filter(Boolean).join(","); }
  }
  results.push({ name, ok, why, vol: vis.volume.on ? `${vis.volume.variable}` : "-", sec: vis.section.on ? `${vis.section.kind}:${vis.section.variable}[${fmt(vis.section.min)},${fmt(vis.section.max)}]` : "-", owner: st.owner });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${why ? "  (" + why + ")" : ""}`);
}
const fmt = (v) => (typeof v === "number" ? Number(v.toPrecision(3)) : String(v));
const reset = () => api(() => {
  const a = window.__atmosApi;
  a.setProbeEnabled(false);
  a.setSection({ enabled: false });
  a.setVolume({ enabled: false, threshold: 0.15, filterSlices: true });
  a.setCuts({ x: [0, 1], y: [0, 1], z: [0, 1], faces: false });
  a.setLayer("particles", false);
});
const TOP = () => api(() => window.__atmosApi.setCamera([0, 26, 0.01], [0, 0, 0]));

// ---------- 1. volume / section on-off orders
await reset();
await api(() => window.__atmosApi.setVolume({ enabled: true, variable: "tke" })); await settle(["tke"]);
await check("volume tke on");
await api(() => window.__atmosApi.setSection({ kind: "lon", variable: "speed" })); await settle(["u", "v"]);
await check("volume on → section lon on (volume auto-off)", (v) => (!v.volume.on ? true : "volume-still-on"));
await api(() => window.__atmosApi.setSection({ enabled: false })); await settle();
await api(() => window.__atmosApi.setVolume({ enabled: true })); await settle();
await check("section off → volume on again");

// ---------- 2. user scenario 4: leftover volume window then v section with manual range
await reset();
await api(() => window.__atmosApi.setVolume({ enabled: true, variable: "icing_index", filterMin: 0.5, filterMax: 0.8, filterSlices: true })); await settle(["icing_index"]);
await api(() => window.__atmosApi.setSection({ kind: "lon", variable: "v", colormap: "glacier", autoRange: false, min: -15, opacity: 1, lowAlpha: false })); await settle(["v"]);
await check("narrow icing window → section v manual min -15", (v) => (v.section.discarded < 0.5 ? true : "too-much-discarded"));
await api(() => window.__atmosApi.setSection({ min: NaN, max: "abc" })); await settle();
await check("section range NaN input sanitized", (v) => (Number.isFinite(v.section.min) && Number.isFinite(v.section.max) ? true : "nan-range"));
await api(() => window.__atmosApi.setSection({ min: 20, max: -20 })); await settle();
await check("section range reversed sanitized", (v) => (v.section.min < v.section.max ? true : "unordered"));

// ---------- 3. mode switches
await reset();
await api(() => window.__atmosApi.setSection({ kind: "lon", variable: "speed" })); await settle(["u", "v"]);
for (const kind of ["lat", "height", "lon"]) {
  await api((k) => window.__atmosApi.setSectionMode(k), kind); await settle();
  await check(`mode → ${kind}`);
}
await api(() => window.__atmosApi.setPolyline([{ x: -4, z: -2 }, { x: 0, z: 1 }, { x: 4, z: -1 }])); await settle();
await check("mode → polyline (3 pts, view)", (v, s) => (!s.drawing ? true : "still-drawing"));
await api(() => window.__atmosApi.setBox({ x0: -3, z0: -2, x1: 3, z1: 2, defined: true })); await settle();
await check("mode → box (defined, view)", (v, s) => (!s.drawing ? true : "still-drawing"));
await api(() => window.__atmosApi.setSectionMode("lat")); await settle();
await check("box → lat");

// ---------- 4. variable switches with auto range on/off and low alpha on/off
for (const name of ["speed", "v", "icing_index", "wind_shear", "tke", "w"]) {
  await api((n) => window.__atmosApi.setSection({ variable: n }), name); await settle(name === "speed" ? ["u", "v"] : [name]);
  await check(`section var → ${name}`);
}
await api(() => window.__atmosApi.setSection({ autoRange: false, min: 0.5, max: 0.6 })); await settle();
await api(() => window.__atmosApi.setSection({ variable: "u" })); await settle(["u"]);
await check("manual range then var switch → range reset", (v) => (v.section.min <= -5 && v.section.max >= 5 ? true : "stale-range"));
await api(() => window.__atmosApi.setSection({ autoRange: true })); await settle();
await check("auto range on");
await api(() => window.__atmosApi.setSection({ variable: "icing_index", lowAlpha: true, lowThreshold: 0.15 })); await settle(["icing_index"]);
await check("icing lowAlpha on");
await api(() => window.__atmosApi.setSection({ lowAlpha: false })); await settle();
await check("icing lowAlpha off");

// ---------- 5. volume cuts / faces / follow filter / cut low alpha
await reset();
await api(() => window.__atmosApi.setVolume({ enabled: true, variable: "wind_shear", opacity: 2, threshold: 0 })); await settle(["wind_shear"]);
await api(() => window.__atmosApi.setCuts({ y: [0.25, 0.75], z: [0.2, 0.8], faces: true })); await settle();
await check("wind_shear cuts + faces (cut low alpha default)", (v) => (v.volume.cutLowAlpha ? true : "cut-low-alpha-off"));
for (const [label, p] of [["filterSlices off", { filterSlices: false }], ["filterSlices on", { filterSlices: true }], ["cutLowAlpha off", { cutLowAlpha: false }], ["cutLowAlpha on", { cutLowAlpha: true }], ["threshold 0.3", { threshold: 0.3 }]]) {
  await api((p) => window.__atmosApi.setVolume(p), p); await settle();
  await check(`volume ${label}`);
}
await api(() => window.__atmosApi.setCuts({ faces: false })); await settle();
await check("cut faces off");
await api(() => window.__atmosApi.setVolume({ filterMin: 0.05, filterMax: 0.1 })); await settle();
await api(() => window.__atmosApi.setVolume({ variable: "tke" })); await settle(["tke"]);
await check("narrow window then volume var switch → window reset", (v) => (!(Math.abs(v.volume.filterMin - 0.05) < 1e-9 && Math.abs(v.volume.filterMax - 0.1) < 1e-9) && v.volume.filterMax > v.volume.filterMin ? true : `stale-window[${v.volume.filterMin},${v.volume.filterMax}]`));
await api(() => window.__atmosApi.setCuts({ x: [0, 1], y: [0, 1], z: [0, 1], faces: false }));

// ---------- 6. drawing state / interaction arbiter (real mouse)
await reset();
await TOP();
await api(() => window.__atmosApi.setSection({ kind: "lon", variable: "speed", autoRange: true, lowAlpha: false, opacity: 0.85 })); await settle(["u", "v"]);
await api(() => window.__atmosApi.setSectionMode("box")); await settle(["u", "v"]);
await check("enter box (no geometry) → drawing", (v, s) => (s.drawing && s.owner === "draw" ? true : `owner=${s.owner}`));
await page.mouse.move(560, 330); await page.mouse.down(); await page.mouse.move(700, 420, { steps: 6 }); await page.mouse.move(820, 520, { steps: 6 }); await page.mouse.up();
await settle();
await check("box mouse-up → view", (v, s) => (s.boxDefined && !s.drawing && s.owner === "camera" ? true : `defined=${s.boxDefined},drawing=${s.drawing},owner=${s.owner}`));
const boxBefore = (await api(() => window.__atmosApi.interactionState())).box;
await api(() => window.__atmosApi.setProbeEnabled(true)); await settle();
await page.mouse.click(420, 640); await settle();
await check("box done → probe click pins, box unchanged", (v, s) => (s.owner === "probe" && s.pinned && JSON.stringify(s.box) === JSON.stringify(boxBefore) ? true : `owner=${s.owner},pinned=${JSON.stringify(s.pinned)}`));
await api(() => window.__atmosApi.setCamera([-9.5, 7.5, 11], [0, 0.4, 0])); await settle(); await frames(6);
await page.evaluate(() => document.querySelector('.draw-actions')?.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: `${outDir}/three-v6_10-box-then-probe.png` });

// probe tooltip: hover the chart
const svg = await page.$(".profile svg.chart");
if (svg) {
  const bb = await svg.boundingBox();
  await page.mouse.move(bb.x + bb.width * 0.55, bb.y + bb.height * 0.45);
  await frames(2);
  const tip = await page.$(".profile .hover .tip");
  results.push({ name: "probe chart hover → tooltip", ok: Boolean(tip), why: tip ? "" : "no-tooltip" });
  console.log(`${tip ? "PASS" : "FAIL"}  probe chart hover → tooltip`);
  await page.screenshot({ path: `${outDir}/three-v6_10-probe-tooltip.png` });
  await page.screenshot({ path: `${outDir}/three-v6_10-probe-tooltip-crop.png`, clip: { x: Math.max(0, bb.x - 20), y: Math.max(0, bb.y - 90), width: bb.width + 40, height: bb.height + 260 } });
  await page.mouse.move(bb.x - 60, bb.y + 10);
} else {
  results.push({ name: "probe chart hover → tooltip", ok: false, why: "no-chart" });
}

// Esc cancels an in-progress box redraw, keeps nothing half-drawn
await TOP(); await settle();
await api(() => window.__atmosApi.drawAction("redraw")); await settle();
await check("重画 → drawing (probe stays on, draw wins)", (v, s) => (s.drawing && s.owner === "draw" && s.probe ? true : `owner=${s.owner}`));
await page.mouse.move(600, 300); await page.mouse.down(); await page.mouse.move(760, 460, { steps: 6 });
await page.keyboard.press("Escape"); await page.mouse.up(); await settle();
await check("Esc mid-drag → cancelled, previous box restored", (v, s) => (!s.drawing && s.boxDefined && JSON.stringify(s.box) === JSON.stringify(boxBefore) ? true : `drawing=${s.drawing},defined=${s.boxDefined}`));
await api(() => window.__atmosApi.setProbeEnabled(false));

// polyline: clicks + double-click finish
await api(() => window.__atmosApi.setSectionMode("polyline")); await settle();
await check("enter polyline (no geometry) → drawing", (v, s) => (s.drawing && s.owner === "draw" ? true : `owner=${s.owner}`));
for (const [x, y] of [[480, 620], [640, 420], [820, 520]]) { await page.mouse.click(x, y); await frames(2); }
await page.mouse.move(980, 330); await frames(2);
await page.evaluate(() => document.querySelector('.draw-actions')?.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: `${outDir}/three-v6_10-polyline-drawing.png` });
await page.mouse.dblclick(980, 330); await settle();
await check("polyline dblclick → view, 4 pts", (v, s) => (!s.drawing && s.points === 4 ? true : `drawing=${s.drawing},points=${s.points}`));
await page.mouse.click(700, 700); await settle();
await check("view: map click does not add points", (v, s) => (s.points === 4 ? true : `points=${s.points}`));
await api(() => window.__atmosApi.setCamera([-9.5, 7.5, 11], [0, 0.4, 0])); await settle(); await frames(6);
await page.evaluate(() => document.querySelector('.draw-actions')?.scrollIntoView({ block: 'center' }));
await page.screenshot({ path: `${outDir}/three-v6_10-polyline-done.png` });
await TOP(); await settle();
// edit → add one point → Enter
await api(() => window.__atmosApi.drawAction("edit")); await settle();
await page.mouse.click(1040, 600); await frames(2); await page.keyboard.press("Enter"); await settle();
await check("编辑 + click + Enter → 5 pts, view", (v, s) => (!s.drawing && s.points === 5 ? true : `drawing=${s.drawing},points=${s.points}`));
// redraw → two clicks → right-click finish
await api(() => window.__atmosApi.drawAction("redraw")); await settle();
await page.mouse.click(500, 500); await frames(2); await page.mouse.click(800, 400); await frames(2);
await page.mouse.click(900, 650, { button: "right" }); await settle();
await check("重画 + right-click → 2 pts, view", (v, s) => (!s.drawing && s.points === 2 ? true : `drawing=${s.drawing},points=${s.points}`));
// probe on while drawing ends drawing, keeps geometry
await api(() => window.__atmosApi.drawAction("edit")); await settle();
await api(() => window.__atmosApi.setProbeEnabled(true)); await settle();
await check("drawing + probe on → drawing ends, geometry kept", (v, s) => (!s.drawing && s.points === 2 && s.owner === "probe" ? true : `drawing=${s.drawing},points=${s.points},owner=${s.owner}`));
await api(() => window.__atmosApi.drawAction("clear")); await settle();
const st = await api(() => window.__atmosApi.interactionState());
results.push({ name: "清除 → no geometry, view", ok: st.points === 0 && !st.drawing, why: "" });
console.log(`${st.points === 0 && !st.drawing ? "PASS" : "FAIL"}  清除 → no geometry, view`);

// ---------- 7. time axis (v6.11; skipped for single-time data)
const tlInfo = await api(() => window.__atmosApi.timeline?.());
if (tlInfo && tlInfo.frames > 1) {
  const atT = async (t) => { await api((t) => window.__atmosApi.setTime(t), t); await page.waitForFunction(() => window.__atmosApi.hasFrame(), null, { timeout: 180_000 }); await frames(3); };
  await reset();
  await api(() => window.__atmosApi.setSection({ kind: "lon", variable: "tke", autoRange: true })); await settle(["tke"]);
  const r0 = (await api(() => window.__atmosApi.debugVisibility())).section;
  await atT(2.5);
  await check("t=2.5 section tke → visible, range unchanged", (v) => (v.section.min === r0.min && v.section.max === r0.max ? true : "range-moved"));
  await api(() => window.__atmosApi.setSection({ enabled: false }));
  await api(() => window.__atmosApi.setVolume({ enabled: true, variable: "icing_index", filterMin: 0.5, filterMax: 0.8 })); await settle(["icing_index"]);
  await atT(6);
  await check("t=6 volume icing narrow window → visible");
  await api(() => window.__atmosApi.setVolume({ enabled: false }));
  await api(() => window.__atmosApi.setSection({ kind: "lon", variable: "speed" })); await settle(["u", "v"]);
  await api(() => window.__atmosApi.setSectionMode("box")); await settle();
  await api(() => window.__atmosApi.stepFrame(-1)); await page.waitForFunction(() => window.__atmosApi.hasFrame(), null, { timeout: 180_000 }); await frames(3);
  await check("drawing + step frame → drawing kept", (v, s) => (s.drawing && s.owner === "draw" ? true : `owner=${s.owner}`));
  await page.keyboard.press("Escape"); await settle();
  await api(() => window.__atmosApi.setSectionMode("lon")); await settle();
  await atT(0);
  await check("back to t=0 lon section");
}

const pass = results.filter((r) => r.ok).length;
console.log(JSON.stringify({ pass, total: results.length, errors }, null, 0));
await browser.close();
process.exit(pass === results.length && !errors.length ? 0 : 1);
