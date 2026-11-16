// v6.11 playback recording: steps the time axis deterministically (t = 0 → 6 h) while the
// particles advance, screenshots every step and encodes an mp4 with ffmpeg.
// Software GL cannot play in real time, so the video is "simulated" playback at the given rate.
// usage: node scripts/record-timeline.mjs [baseUrl] [outDir]   env: FPS (8), RATE (2), FRAMES_DIR
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
const base = argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4173/";
const out = argv.find((a) => a.startsWith("/")) ?? "/tmp";
const fps = Number(process.env.FPS ?? 8);
const rate = Number(process.env.RATE ?? 2); // playback rate (1× = 1 h of data per 4 s)
const prefix = process.env.PREFIX ?? "three-v6_11";
const dir = process.env.FRAMES_DIR ?? `${out}/${prefix}-playback-frames`;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--headless=new", "--no-sandbox", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__atmosReady === true, null, { timeout: 120_000 });
await page.waitForFunction(() => window.__atmosApi.timeline().ready.every(Boolean), null, { timeout: 180_000 });
await page.evaluate((rate) => {
  const a = window.__atmosApi;
  a.setView("slice");
  a.setSlice({ heightM: 100, variable: "speed", opacity: 0.8, contours: 10 });
  a.setCamera([-14.5, 9, 13.5], [0.5, 0.3, -0.5]);
  a.setParticles({ count: 48000 });
  a.setPlayback({ rate });
  a.setTime(0);
  a.advance(120, 1 / 60);
}, rate);

const hoursPerFrame = rate / 4 / fps; // 1× = 4 s per hour
const total = Math.round(6 / hoursPerFrame) + 1;
const t0 = Date.now();
for (let i = 0; i < total; i += 1) {
  const t = Math.min(6, i * hoursPerFrame);
  await page.evaluate(async ({ t, steps }) => {
    const a = window.__atmosApi;
    a.setTime(t);
    let n = 0;
    while (!a.hasFrame() && n < 3000) { await new Promise((r) => requestAnimationFrame(r)); n += 1; }
    a.advance(steps, 1 / 60);
  }, { t, steps: Math.round(60 / fps) });
  await page.screenshot({ path: `${dir}/f${String(i).padStart(4, "0")}.png`, timeout: 180_000 });
  if (i % 10 === 0) console.log(`frame ${i}/${total} t=${t.toFixed(3)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
await browser.close();
const mp4 = `${out}/${prefix}-playback.mp4`;
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", `${dir}/f%04d.png`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", mp4]);
console.log(JSON.stringify({ mp4, frames: total, fps, rate, seconds: total / fps }));
