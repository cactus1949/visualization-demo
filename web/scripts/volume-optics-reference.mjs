/**
 * Reference integral of one real SZ3 frame. Not the app, and it does not change TLS.
 * Packs must already be on disk. From web/:
 *   node scripts/volume-optics-reference.mjs /tmp/gust-frame /opt/cursor/artifacts/volume-optics /tmp/sz3-manifest.json
 *
 * The step transfer is the same function as src/render/volumeOptics.ts (covered by its test).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import factory from "../src/data/codecs/sz3/sz3_O3.mjs";
import { colormapRGB } from "../src/render/colormaps.ts";
import { integrateNormalized, normalized } from "../src/render/volumeOptics.ts";

const nx = 300;
const ny = 300;
const nz = 40;
const dxKm = 0.06;
const levels = Array.from({ length: nz }, (_, i) => 12.5 + i * 25);

async function decoder() {
  const wasmPath = fileURLToPath(new URL("../src/data/codecs/sz3/sz3_O3.wasm", import.meta.url));
  const wasm = fs.readFileSync(wasmPath);
  const mod = await factory({
    instantiateWasm(imports, receive) {
      WebAssembly.instantiate(wasm, imports).then((result) => receive(result.instance));
      return {};
    },
  });
  let inPtr = 0;
  let inCap = 0;
  let outPtr = 0;
  let outCap = 0;
  return (bytes, slab) => {
    if (bytes.length > inCap) {
      if (inPtr) mod._sz3_free(inPtr);
      inPtr = mod._sz3_malloc(bytes.length);
      inCap = bytes.length;
    }
    if (slab > outCap) {
      if (outPtr) mod._sz3_free(outPtr);
      outPtr = mod._sz3_malloc(slab * 4);
      outCap = slab;
    }
    mod.HEAPU8.set(bytes, inPtr);
    const n = mod._sz3_decompress_f32(inPtr, bytes.length, outPtr, slab);
    if (n !== slab) throw new Error(`SZ3 decode got ${n}, expected ${slab}`);
    return mod.HEAPF32.slice(outPtr >> 2, (outPtr >> 2) + slab);
  };
}

function loadPack(decode, dir, name) {
  const bytes = fs.readFileSync(path.join(dir, `${name}.sz3pack`));
  const index = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
  const slab = index.slab_shape.reduce((a, b) => a * b, 1);
  const total = index.shape.reduce((a, b) => a * b, 1);
  const out = new Float32Array(total);
  index.offsets.forEach((offset, i) => {
    const length = index.lengths[i];
    out.set(decode(bytes.subarray(offset, offset + length), slab), i * slab);
  });
  return out;
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width * 3; x += 1) raw[row + 1 + x] = rgb[y * width * 3 + x];
  }
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    name.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(Buffer.concat([name, data])) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function scaleNearest(src, sw, sh, factor) {
  const width = sw * factor;
  const height = sh * factor;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const si = (Math.floor(y / factor) * sw + Math.floor(x / factor)) * 3;
      const di = (y * width + x) * 3;
      rgb[di] = src[si];
      rgb[di + 1] = src[si + 1];
      rgb[di + 2] = src[si + 2];
    }
  }
  return { rgb, width, height };
}

function paintScalar(values, width, height, min, max) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const [r, g, b] = colormapRGB("turbo", normalized(values[i], min, max));
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return rgb;
}

function resample(values, count) {
  if (count >= values.length) return values;
  const out = [];
  const bucket = values.length / count;
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor(i * bucket);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucket));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += values[j];
    out.push(sum / (end - start));
  }
  return out;
}

function marchColor(column, stepKm, params) {
  const samples = column.map((value) => normalized(value, params.min, params.max));
  let alpha = 0;
  const rgb = [0, 0, 0];
  for (const n of samples) {
    if (alpha > 0.97) break;
    const one = integrateNormalized([n], stepKm, params, Infinity);
    if (one.alpha <= 0) continue;
    const color = colormapRGB("turbo", n);
    const weight = (1 - alpha) * one.alpha;
    rgb[0] += weight * color[0];
    rgb[1] += weight * color[1];
    rgb[2] += weight * color[2];
    alpha += weight;
  }
  if (alpha <= 0) return [0, 0, 0];
  return rgb.map((channel) => Math.round(channel / alpha));
}

const packDir = process.argv[2] ?? "/tmp/gust-frame";
const outDir = process.argv[3] ?? "/opt/cursor/artifacts/volume-optics";
const manifestPath = process.argv[4] ?? "/tmp/sz3-manifest.json";
fs.mkdirSync(outDir, { recursive: true });

const decode = await decoder();
const u = loadPack(decode, packDir, "u");
const v = loadPack(decode, packDir, "v");
const ustar = loadPack(decode, packDir, "ustar");
const gust = new Float32Array(nx * ny * nz);
let lo = Infinity;
let hi = -Infinity;
for (let z = 0; z < nz; z += 1) {
  const k = 2.4 * Math.pow(Math.max(1 - levels[z] / 1000, 0), 1 / 3);
  for (let i = 0; i < nx * ny; i += 1) {
    const value = Math.hypot(u[z * nx * ny + i], v[z * nx * ny + i]) + 2 * k * ustar[i];
    gust[z * nx * ny + i] = value;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const display = manifest.variables.u_gust.display_range;
const level0 = gust.subarray(0, nx * ny);
const raw = paintScalar(level0, nx, ny, display[0], display[1]);
const scaledRaw = scaleNearest(raw, nx, ny, 2);
fs.writeFileSync(path.join(outDir, "gust-level0-display-0-25.png"), png(scaledRaw.width, scaledRaw.height, scaledRaw.rgb));
const stretched = scaleNearest(paintScalar(level0, nx, ny, lo, hi), nx, ny, 2);
fs.writeFileSync(path.join(outDir, "gust-level0-stretched-frame-minmax.png"), png(stretched.width, stretched.height, stretched.rgb));

function marchImage(steps, params) {
  const rgb = new Uint8Array(nx * nz * 3);
  for (let z = 0; z < nz; z += 1) {
    for (let x = 0; x < nx; x += 1) {
      const column = [];
      for (let y = 0; y < ny; y += 1) column.push(gust[z * nx * ny + y * nx + x]);
      const samples = resample(column, steps);
      const [r, g, b] = marchColor(samples, (dxKm * ny) / samples.length, params);
      const at = ((nz - 1 - z) * nx + x) * 3;
      rgb[at] = r;
      rgb[at + 1] = g;
      rgb[at + 2] = b;
    }
  }
  return rgb;
}

function writeMarch(name, steps, params) {
  const image = scaleNearest(marchImage(steps, params), nx, nz, 2);
  fs.writeFileSync(path.join(outDir, name), png(image.width, image.height, image.rgb));
}

const beer2 = { opacity: 2, threshold: 0, min: display[0], max: display[1], mode: "beer" };
const linear2 = { ...beer2, mode: "linear" };
writeMarch("march-opacity2-beer-32.png", 32, beer2);
writeMarch("march-opacity2-beer-128.png", 128, beer2);
writeMarch("march-opacity2-linear-32.png", 32, linear2);
writeMarch("march-opacity2-linear-128.png", 128, linear2);
writeMarch("march-opacity0.15-beer-128.png", 128, { ...beer2, opacity: 0.15 });

const report = {
  source: "sz3 20261111 t000. gust = hypot(u, v) + 2 * 2.4 * ustar * (1 - z/1000)^(1/3). March looks along +y at fixed height.",
  decodedMin: lo,
  decodedMax: hi,
  manifestFrame0: manifest.variables.u_gust.frames[0],
  displayRange: display,
  level0Mean: level0.reduce((sum, value) => sum + value, 0) / level0.length,
  note: "Opacity 2 is the user's slider. Opacity 0.15 is a labelled control and is not that slider. Linear is the previous step formula on the same samples. gust-level0-stretched-frame-minmax.png stretches this frame's own min/max onto turbo so spatial structure is visible; the volume does not use that stretch, it uses display_range 0–25.",
};
fs.writeFileSync(path.join(outDir, "reference.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
