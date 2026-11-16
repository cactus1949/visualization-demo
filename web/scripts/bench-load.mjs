// Headless load-time benchmark for field payload variants.
// usage: node scripts/bench-load.mjs [--payloads /tmp/atmos-load-payloads] [--dist dist] [--out /tmp/bench-load.json]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const payloads = path.resolve(opt("--payloads", "/tmp/atmos-load-payloads"));
const dist = path.resolve(opt("--dist", path.join(here, "../dist")));
const outFile = path.resolve(opt("--out", "/tmp/atmos-load-results.json"));
const repeats = Number(opt("--repeats", "3"));

const VARIANTS = ["w-f16", "w-u8-per-level", "w-u16-per-level", "v4-all-u8"];
const NETWORKS = {
  none: { label: "no throttle", latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  fast: { label: "~100 Mbps, 10 ms", latency: 10, downloadThroughput: (100e6) / 8, uploadThroughput: (20e6) / 8 },
  medium: { label: "~20 Mbps, 40 ms", latency: 40, downloadThroughput: (20e6) / 8, uploadThroughput: (5e6) / 8 },
  slow: { label: "~5 Mbps, 80 ms", latency: 80, downloadThroughput: (5e6) / 8, uploadThroughput: (1e6) / 8 },
};
// fields-only for every network; full page (buildings too) on none + medium.
const JOBS = [];
for (const variant of VARIANTS) {
  for (const network of Object.keys(NETWORKS)) {
    JOBS.push({ variant, network, noBuildings: true });
  }
  for (const network of ["none", "medium"]) {
    JOBS.push({ variant, network, noBuildings: false });
  }
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".glb")) return "model/gltf-binary";
  if (file.endsWith(".bin.br")) return "application/octet-stream";
  return "application/octet-stream";
}

function startServer(dataDir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let relative = decodeURIComponent(url.pathname);
    if (relative === "/") relative = "/index.html";
    let file;
    if (relative.startsWith("/data/lowair_atmos/")) {
      file = path.resolve(dataDir, relative.slice("/data/lowair_atmos/".length));
      if (!file.startsWith(path.resolve(dataDir))) {
        res.writeHead(403); res.end("forbidden"); return;
      }
    } else {
      file = path.resolve(dist, relative.slice(1));
      if (!file.startsWith(path.resolve(dist))) {
        res.writeHead(403); res.end("forbidden"); return;
      }
    }
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("not found " + relative); return;
    }
    if (file.endsWith(".bin.br")) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Encoding", "br");
    } else {
      res.setHeader("Content-Type", contentType(file));
    }
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function classify(url) {
  if (url.includes("/data/lowair_atmos/") && url.endsWith(".bin.br")) {
    const name = url.split("/").pop().replace(".bin.br", "");
    return { kind: "field", name };
  }
  if (url.includes("manifest.json") && url.includes("lowair_atmos")) return { kind: "manifest" };
  if (url.includes("buildings.glb")) return { kind: "buildings" };
  if (url.includes("loader.worker")) return { kind: "worker" };
  return { kind: "other" };
}

async function oneRun(browser, job) {
  const dataDir = path.join(payloads, job.variant);
  const { server, port } = await startServer(dataDir);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const net = NETWORKS[job.network];
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: net.latency,
    downloadThroughput: net.downloadThroughput,
    uploadThroughput: net.uploadThroughput,
  });

  const transfers = [];
  page.on("requestfinished", async (request) => {
    try {
      const sizes = await request.sizes();
      const response = await request.response();
      transfers.push({
        url: request.url(),
        ...classify(request.url()),
        status: response?.status() ?? 0,
        encodedBody: sizes.responseBodySize,
        encodedHeader: sizes.responseHeadersSize,
        timing: request.timing(),
      });
    } catch {
      /* aborted */
    }
  });

  const query = job.noBuildings ? "?noBuildings=1" : "";
  const url = `http://127.0.0.1:${port}/${query}`;
  const tNav = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(
    () => window.__atmosReady === true && window.__atmosTimings?.firstFrameMs != null,
    null,
    { timeout: 180_000 },
  );
  const wallMs = Date.now() - tNav;
  const timings = await page.evaluate(() => window.__atmosApi.timings());
  const status = await page.evaluate(() => window.__atmosApi.status());
  await context.close();
  server.close();

  const fieldNet = transfers.filter((t) => t.kind === "field");
  const buildingsNet = transfers.filter((t) => t.kind === "buildings");
  const fieldEncoded = fieldNet.reduce((s, t) => s + t.encodedBody, 0);
  const files = timings.files ?? {};
  const preload = ["u", "v", "w", "tke", "t2m"];
  const sum = (key) => preload.reduce((s, n) => s + (files[n]?.[key] ?? 0), 0);
  const wind = ["u", "v", "w"];
  return {
    variant: job.variant,
    network: job.network,
    noBuildings: job.noBuildings,
    wallNavToReadyMs: wallMs,
    firstFrameMs: timings.firstFrameMs,
    manifestMs: timings.manifestMs,
    manifestFetchMs: timings.manifestFetchMs,
    buildingsMs: timings.buildingsMs,
    files,
    uploadMs: timings.uploadMs,
    decodeSumMs: sum("decodeMs"),
    fetchSumMs: sum("fetchMs"),
    windDecodeSumMs: wind.reduce((s, n) => s + (files[n]?.decodeMs ?? 0), 0),
    windFetchSumMs: wind.reduce((s, n) => s + (files[n]?.fetchMs ?? 0), 0),
    uploadWindMs: timings.uploadMs?.wind,
    fieldEncodedBytes: fieldEncoded,
    buildingsEncodedBytes: buildingsNet.reduce((s, t) => s + t.encodedBody, 0),
    gpu: status?.gpu ?? null,
    transfers: transfers.map(({ url, kind, name, encodedBody, status }) => ({
      url: url.replace(/https?:\/\/127\.0\.0\.1:\d+/, ""),
      kind,
      name,
      encodedBody,
      status,
    })),
  };
}

function median(values) {
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const gpuFlags = process.env.ATMOS_GPU
  ? ["--use-gl=angle", "--use-angle=vulkan", "--enable-gpu"]
  : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--headless=new", "--no-sandbox", "--ignore-gpu-blocklist", ...gpuFlags],
});

const runs = [];
try {
  for (const job of JOBS) {
    for (let i = 0; i < repeats; i += 1) {
      process.stderr.write(`${job.variant} ${job.network} ${job.noBuildings ? "fields" : "full"} run ${i + 1}/${repeats}...\n`);
      const result = await oneRun(browser, job);
      runs.push({ ...result, rep: i + 1 });
      process.stderr.write(`  firstFrame=${result.firstFrameMs?.toFixed?.(1)} wall=${result.wallNavToReadyMs} decodeSum=${result.decodeSumMs?.toFixed?.(1)} uploadWind=${result.uploadWindMs?.toFixed?.(1)}\n`);
    }
  }
} finally {
  await browser.close();
}

const groups = new Map();
for (const run of runs) {
  const key = `${run.variant}|${run.network}|${run.noBuildings ? "fields" : "full"}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(run);
}
const medians = [];
for (const [key, xs] of groups) {
  const pick = (fn) => median(xs.map(fn).filter((v) => typeof v === "number" && Number.isFinite(v)));
  medians.push({
    variant: xs[0].variant,
    network: xs[0].network,
    mode: xs[0].noBuildings ? "fields" : "full",
    n: xs.length,
    firstFrameMs: pick((r) => r.firstFrameMs),
    wallNavToReadyMs: pick((r) => r.wallNavToReadyMs),
    fetchSumMs: pick((r) => r.fetchSumMs),
    decodeSumMs: pick((r) => r.decodeSumMs),
    windFetchSumMs: pick((r) => r.windFetchSumMs),
    windDecodeSumMs: pick((r) => r.windDecodeSumMs),
    uploadWindMs: pick((r) => r.uploadWindMs),
    buildingsMs: pick((r) => r.buildingsMs),
    fieldEncodedBytes: pick((r) => r.fieldEncodedBytes),
    wFetchMs: pick((r) => r.files?.w?.fetchMs),
    wDecodeMs: pick((r) => r.files?.w?.decodeMs),
  });
}

const payload = { when: new Date().toISOString(), gpuFlags, repeats, runs, medians };
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ outFile, jobs: JOBS.length, runs: runs.length, medians }, null, 2));
