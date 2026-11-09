// Offline frame-by-frame recording (software GL is ~1 fps, so frames are stepped explicitly
// and then encoded at 30 fps with ffmpeg). usage: node scripts/record.mjs [url] [outDir]
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.argv[2] ?? "http://localhost:4173/";
const dir = process.argv[3] ?? "/tmp/atmos-frames";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: [
    "--headless=new",
    "--no-sandbox",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const page = await browser.newPage({
  viewport: { width: Number(process.env.W ?? 960), height: Number(process.env.H ?? 540) },
});
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__atmosReady === true, null, { timeout: 90_000 });
await page.waitForFunction(() => (window.__atmosStatus?.buildings ?? 0) > 0, null, {
  timeout: 60_000,
});
await page.evaluate(() => {
  const api = window.__atmosApi;
  api.setView("section");
  api.setSection({ variable: "speed", azimuthDeg: 90, offsetKm: -4 });
  api.setParticles({ paused: true });
  api.advance(60, 1 / 60);
});
const frames = Number(process.env.FRAMES ?? 150);
const nextFrame = () =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
for (let i = 0; i < frames; i += 1) {
  const t = i / (frames - 1);
  await page.evaluate(
    ({ t }) => {
      const api = window.__atmosApi;
      // phase 1: drag the wall north→south; phase 2: rotate it; camera orbits slowly
      if (t < 0.55) api.setSection({ offsetKm: -4 + (t / 0.55) * 8, azimuthDeg: 90 });
      else
        api.setSection({
          offsetKm: 4 - ((t - 0.55) / 0.45) * 4,
          azimuthDeg: 90 + ((t - 0.55) / 0.45) * 60,
        });
      const a = -2.2 + t * 0.6;
      api.setCamera([Math.cos(a) * 17, 7.5, -Math.sin(a) * 17], [0.3, 0.6, -0.3]);
      api.advance(2, 1 / 60);
    },
    { t },
  );
  await nextFrame();
  await page.screenshot({
    path: `${dir}/f${String(i).padStart(4, "0")}.jpg`,
    quality: 88,
    type: "jpeg",
  });
}
console.log(JSON.stringify({ frames, dir }));
await browser.close();
