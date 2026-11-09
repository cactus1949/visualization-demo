import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const baseUrl = args.find((value) => !value.startsWith("--")) ?? "http://localhost:4173/";
const output = args.find((value) => value.endsWith(".png")) ?? "/tmp/atmos.png";
const webgl = args.includes("--webgl");
const flags = ["--headless=new", "--no-sandbox"];
if (webgl) {
  flags.push("--use-angle=swiftshader", "--enable-unsafe-swiftshader");
} else {
  flags.push(
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-angle=swiftshader",
    "--use-webgpu-adapter=swiftshader",
    "--enable-unsafe-swiftshader",
  );
}

const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: flags,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.stack || String(error) || error.name));
const url = new URL(baseUrl);
if (webgl) url.searchParams.set("webgl", "1");
await page.goto(url.toString(), { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__atmosReady === true, { timeout: 30_000 });
await page.waitForTimeout(3_000);
// Pixel statistics are computed on decoded canvas pixels inside the page, not on PNG bytes.
// Decode the screenshot PNG in the page (createImageBitmap) and compute luma stats on pixels.
const pixelStats = async () => {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(async (data) => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const bitmap = await createImageBitmap(blob, { resizeWidth: 320, resizeHeight: 200 });
    const probe = new OffscreenCanvas(320, 200);
    const context = probe.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, 320, 200).data;
    const luma = [];
    for (let i = 0; i < pixels.length; i += 4) {
      luma.push(0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]);
    }
    const mean = luma.reduce((x, y) => x + y, 0) / luma.length;
    const std = Math.sqrt(luma.reduce((x, y) => x + (y - mean) ** 2, 0) / luma.length);
    return { mean, std, luma };
  }, png);
};
const sampleBefore = await page.evaluate(() => window.__atmosStatus?.particleSample ?? []);
const first = await pixelStats();
await page.waitForTimeout(1_000);
const second = await pixelStats();
const sampleAfter = await page.evaluate(() => window.__atmosStatus?.particleSample ?? []);
await page.screenshot({ path: output });
let changed = 0;
for (let i = 0; i < first.luma.length; i += 1) {
  if (Math.abs(first.luma[i] - second.luma[i]) > 4) changed += 1;
}
const result = {
  backend: await page.evaluate(() => window.__atmosStatus?.backend),
  particlePath: await page.evaluate(() => window.__atmosStatus?.particlePath),
  hud: await page.evaluate(() => document.querySelector(".hud, .status, header")?.textContent?.trim()),
  nonBlank: second.std > 5,
  canvasMeanLuma: second.mean,
  canvasStdLuma: second.std,
  movementEvidence: {
    changedPixelFraction: changed / first.luma.length,
    particleSampleBefore: sampleBefore,
    particleSampleAfter: sampleAfter,
    intervalSeconds: 1,
  },
  consoleErrors,
};
console.log(JSON.stringify(result));
await browser.close();
