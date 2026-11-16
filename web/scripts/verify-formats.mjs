// v6.13 acceptance: both formats via the API, format switch keeps camera + time, SZ3 playback.
// usage: node scripts/verify-formats.mjs <proxyBase e.g. http://127.0.0.1:5173> <dataBaseBuild e.g. http://127.0.0.1:5174> <outDir>
import { chromium } from "playwright-core";
import fs from "node:fs";

const [proxy = "http://127.0.0.1:5173", based = "http://127.0.0.1:5174", out = "/workspace/visualization-demo-analysis"] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--headless=new", "--no-sandbox", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const report = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(url) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.__atmosReady === true, null, { timeout: 180000 });
  await page.waitForFunction(() => document.querySelector(".hud")?.textContent?.includes("风场就绪"), null, { timeout: 180000 });
  return { page, errors, readyMs: Date.now() - t0 };
}
const hud = (page) => page.evaluate(() => document.querySelector(".hud")?.textContent?.replace(/\s+/g, " ").trim());
const api = (page, fn, ...a) => page.evaluate(([fn, a]) => window.__atmosApi[fn](...a), [fn, a]);

async function waitReadyAt(page, t) {
  await page.waitForFunction((t) => window.__atmosApi.hasFrame?.(t) !== false && window.__atmosApi.status().ready.every(Boolean), t, { timeout: 180000 }).catch(() => {});
  await sleep(1500);
}

const only = (process.env.ONLY ?? "1,2,3,4").split(",");

// 1) both formats, no ?date (latest day from /api/days through the dev proxy)
if (only.includes("1")) for (const f of ["current", "sz3"]) {
  const { page, errors, readyMs } = await open(`${proxy}/?format=${f}`);
  await sleep(2000);
  report[`proxy-latest-${f}`] = { readyMs, hud: await hud(page), errors };
  await page.screenshot({ path: `${out}/three-v6_13-${f}-latest.png` });
  await page.close();
}

// 2) both formats with ?date via VITE_DATA_BASE (direct to FastAPI)
if (only.includes("2")) for (const f of ["current", "sz3"]) {
  const { page, errors, readyMs } = await open(`${based}/?date=20261111&format=${f}`);
  await api(page, "setTime", 3);
  await waitReadyAt(page, 3);
  report[`api-date-${f}`] = { readyMs, hud: await hud(page), status: await api(page, "status"), errors };
  // values of stored + derived variables at t=3 (probe makes the variable resident)
  const stats = {};
  for (const v of ["u", "w", "tke", "u_gust", "sigma_u", "sigma_w"]) {
    await api(page, "setProbeVariable", v);
    await api(page, "probeAt", 150, 150);
    await page.waitForFunction((v) => window.__atmosApi.hasData(v), v, { timeout: 60000 }).catch(() => {});
    stats[v] = await api(page, "debugStats", v);
  }
  for (const v of ["risk_level", "cloud_low", "ustar", "t2m"]) {
    await api(page, "setGroundVar", v);
    await page.waitForFunction((v) => window.__atmosApi.hasData(v), v, { timeout: 60000 }).catch(() => {});
    stats[v] = await api(page, "debugStats", v);
  }
  report[`api-date-${f}`].stats = stats;
  await api(page, "setGroundVar", "speed0");
  await page.screenshot({ path: `${out}/three-v6_13-${f}-date.png` });
  await page.close();
}

// 3) switch SZ3 -> current -> SZ3 keeps camera and time
if (only.includes("3")) {
  const { page, errors } = await open(`${based}/?date=20261111&format=sz3`);
  // a low, rotated view derived from the default one (scene units differ per case)
  const init = await api(page, "snapshot");
  const [cx, cy, cz] = init.camera, [tx, ty, tz] = init.target;
  const dx = cx - tx, dz = cz - tz;
  const ang = Math.atan2(dz, dx) + 0.9, r = Math.hypot(dx, dz) * 0.75;
  await api(page, "setCamera", [tx + r * Math.cos(ang), ty + (cy - ty) * 0.35, tz + r * Math.sin(ang)], [tx, ty, tz]);
  await api(page, "setTime", 2.5);
  await sleep(1500);
  const before = await api(page, "snapshot");
  await page.click("nav.codec-nav button:has-text('当前编码')");
  await sleep(500);
  await page.waitForFunction(() => window.__atmosReady === true && document.querySelector(".hud")?.textContent?.includes("风场就绪"), null, { timeout: 180000 });
  await waitReadyAt(page, 2.5);
  const afterCurrent = await api(page, "snapshot");
  const urlCurrent = page.url();
  await page.screenshot({ path: `${out}/three-v6_13-switch-current.png` });
  await page.click("nav.codec-nav button:has-text('SZ3')");
  await sleep(500);
  await page.waitForFunction(() => document.querySelector(".hud")?.textContent?.includes("SZ3") && document.querySelector(".hud")?.textContent?.includes("风场就绪"), null, { timeout: 180000 });
  await waitReadyAt(page, 2.5);
  const afterSz3 = await api(page, "snapshot");
  await page.screenshot({ path: `${out}/three-v6_13-switch-sz3.png` });
  report.switch = { before, afterCurrent, urlCurrent, afterSz3, urlSz3: page.url(), hud: await hud(page), errors };
  await page.close();
}

// 4) SZ3 playback across frames at 4x
if (only.includes("4")) {
  const { page, errors } = await open(`${based}/?date=20261111&format=sz3`);
  await api(page, "setTime", 0);
  await api(page, "setPlayback", { rate: 4, loop: false });
  await sleep(1000);
  await api(page, "play");
  const samples = [];
  const t0 = Date.now();
  let shot = 0;
  while (Date.now() - t0 < 240000) {
    const s = await api(page, "status");
    samples.push({ ms: Date.now() - t0, t: +s.t.toFixed(3), playing: s.playing, ready: s.ready.filter(Boolean).length });
    if (shot === 0 && s.t >= 3) { await page.screenshot({ path: `${out}/three-v6_13-sz3-play-t3.png` }); shot = 1; }
    if (!s.playing && s.t >= 5.99) break;
    await sleep(1000);
  }
  await page.screenshot({ path: `${out}/three-v6_13-sz3-play-end.png` });
  report.playback = { samples, final: samples.at(-1), hud: await hud(page), errors };
  await page.close();
}

const file = `${out}/three-v6_13-verify.json`;
const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
fs.writeFileSync(file, JSON.stringify({ ...prev, ...report }, null, 1));
console.log(JSON.stringify(report, (k, v) => (k === "samples" ? `${v.length} samples` : v), 1));
await browser.close();
