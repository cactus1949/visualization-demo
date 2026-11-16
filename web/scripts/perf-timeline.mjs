// v6.11 light-scene perf + probe-follows-time check (software GL; relative numbers only).
// usage: node scripts/perf-timeline.mjs [baseUrl] [outJson]
import { chromium } from "playwright-core";
import fs from "node:fs";
const argv = process.argv.slice(2);
const base = argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4173/";
const outJson = argv.find((a) => a.endsWith(".json")) ?? "/tmp/perf-timeline.json";
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--headless=new", "--no-sandbox", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(base + "?noBuildings=1", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__atmosReady === true, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__atmosApi.timeline().ready.every(Boolean), null, { timeout: 180_000 });
const res = await page.evaluate(async () => {
  const a = window.__atmosApi;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  a.setParticles({ count: 16000 });
  const out = { probe: [], step: [], fps: {} };
  // probe follows t
  a.probeAt(150, 150); a.setProbeVariable("speed");
  for (const t of [0, 2.5, 3, 6]) {
    a.setTime(t); while (!a.hasFrame()) await raf();
    await new Promise((r) => setTimeout(r, 400)); await raf(); await raf();
    const rows = [...document.querySelectorAll(".profile-box .stats div, .profile-box .stat, .profile-box tr, .profile-box li")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
    const txt = document.querySelector(".profile-box")?.textContent.replace(/\s+/g, " ") ?? "";
    const m = txt.match(/近地面.{0,20}?([\d.]+) m\/s/);
    out.probe.push({ t, nearGround: m ? Number(m[1]) : null, rows: rows.slice(0, 4) });
  }
  a.setProbeEnabled(false);
  for (const target of [0, 1, 2, 5, 0, 3, 6, 2.5]) {
    const t0 = performance.now(); a.setTime(target); let n = 0;
    while (!a.hasFrame() && n < 3000) { await raf(); n += 1; }
    out.step.push({ to: target, ms: Math.round(performance.now() - t0), rafFrames: n });
  }
  const measure = async (ms) => { let n = 0; let buf = 0; const t0 = performance.now(); const tl0 = a.timeline().t;
    while (performance.now() - t0 < ms) { await raf(); n += 1; if (a.timeline().buffering) buf += 1; }
    const sec = (performance.now() - t0) / 1000; return { fps: +(n / sec).toFixed(2), frames: n, bufferingFrames: buf, dataHours: +(a.timeline().t - tl0).toFixed(3), wallS: +sec.toFixed(1) }; };
  a.setTime(0); while (!a.hasFrame()) await raf();
  out.fps.paused = await measure(8000);
  for (const rate of [1, 4]) { a.setTime(0); while (!a.hasFrame()) await raf(); a.setPlayback({ rate }); a.play(); out.fps[`playing_${rate}x`] = await measure(12000); a.pause(); }
  out.stats = a.timeStats(); out.firstFrameMs = a.timings().firstFrameMs;
  return out;
});
fs.writeFileSync(outJson, JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 1));
await browser.close();
