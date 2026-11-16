import * as THREE from "three";

/**
 * Colormaps sampled from matplotlib at 32 evenly spaced stops (hex RGB, 6 chars per stop)
 * and linearly interpolated to a 256-entry lookup texture. "rdbu" is RdBu_r (blue = negative).
 */
const STOPS: Record<string, string> = {
  // hand-made for particles on dark backgrounds: deep blue → cyan → white → warm yellow
  glacier:
    "1d4e89" +
    "2470a8" +
    "2f93c6" +
    "45b6de" +
    "6dd3ee" +
    "a2e8f7" +
    "d8f6fc" +
    "fff8e0" +
    "ffe39a" +
    "ffc65a",
  viridis: [
    "440154470d6048186a482374472e7c4538824241863e4a893a548c365d8d32658e2e6d8e2b758e287d8e25848e228c8d",
    "1f948c1e9c8920a38625ab822eb37c3aba7648c16e58c7656ccd5a7fd34e93d741a8db34c0df25d5e21aeae51afde725",
  ].join(""),
  magma: [
    "0000040303120a0822130d341e11492a115c38106c45107754137d6018806d1d81792282882781942c80a1307eae347b",
    "bd3977ca3e72d6456ce24d66ec5860f3655cf8745cfb835ffd9467fea36ffeb27afec185fed194fde0a1fceeb0fcfdbf",
  ].join(""),
  turbo: [
    "30123b392a734040a24456c7476ee64682f84196ff35abf825c0e71ad2d218e0bd22ebaa3cf58e59fb7379fe5996fe44",
    "affa37c3f134d7e535e7d739f5c53afcb336fe9e2ffc8725f66c19ed5510e2430ad43305c12302ac1701950d017a0403",
  ].join(""),
  cividis: [
    "00224e00285b002e6a0533711c396f293f6e33446d3c4a6c45506c4d556c555b6d5c616e6467706b6d72727274787877",
    "807f78888578908b78979177a09875a89e73b0a571b9ab6dc2b369cbb965d3c05fdcc859e6d051efd748f8df3cfee838",
  ].join(""),
  rdbu: [
    "0530610e41791752901f63a82b73b33681ba408fc1569fc971b0d38ac0dba0cce2b3d6e8cae1eed8e9f1e4eef4f0f4f6",
    "f8f2effae9dffce0d0fcd5bff9c2a7f6b191f19e7de8896cdd7059d35a4ac84440bd2d35ae172a960f277f082367001f",
  ].join(""),
  blues: [
    "f7fbfff1f7fdeaf3fbe4eff9ddeaf7d7e6f5d1e2f3cbdef1c3daeeb9d6eaafd1e7a5cde399c7e08cc0dd7fb9da72b2d8",
    "65aad45ba3d0519ccc4695c83c8cc33484bf2c7cba2373b61c6ab01562a90f5aa309529d08499008418408387708306b",
  ].join(""),
  coolwarm: [
    "3b4cc0445acc4e68d85875e16384eb6e90f2799cf884a7fc90b2fe9bbcffa6c4feb1cbfcbcd2f7c6d6f1cfdaead8dce2",
    "e1dad6e9d5cbefcfbff3c8b2f6bea4f7b497f7a98bf59d7ef18f71ec8165e67259df634ed55042cb3e38c0282fb40426",
  ].join(""),
  inferno: [
    "0000040403120b0724150b37230c4c310a5c3e09664c0c6b5a116e67166e741a6e801f6c8f24699b2964a82e5fb43359",
    "c13a50cc4248d74b3fe05536e9612bef6e21f57b17f8890cfb9906fca80dfbb81df9c72ff5d949f2e865f3f586fcffa4",
  ].join(""),
};

export const COLORMAP_LABELS: Record<string, string> = {
  glacier: "Glacier（深色背景）",
  viridis: "Viridis",
  magma: "Magma",
  turbo: "Turbo",
  cividis: "Cividis",
  rdbu: "RdBu（发散）",
  blues: "Blues",
  coolwarm: "Coolwarm（发散）",
  inferno: "Inferno",
};

export const COLORMAPS = Object.keys(STOPS);

/** Diverging maps get a symmetric range around zero by default. */
export const DIVERGING = new Set(["rdbu", "coolwarm"]);

function stop(name: string, index: number): [number, number, number] {
  const hex = STOPS[name] ?? STOPS.viridis;
  const at = index * 6;
  return [
    parseInt(hex.slice(at, at + 2), 16),
    parseInt(hex.slice(at + 2, at + 4), 16),
    parseInt(hex.slice(at + 4, at + 6), 16),
  ];
}

/** 256 x RGBA8 lookup table for a colormap. */
export function colormapBytes(name: string): Uint8Array {
  const count = (STOPS[name] ?? STOPS.viridis).length / 6;
  const bytes = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i += 1) {
    const position = (i / 255) * (count - 1);
    const lo = Math.min(count - 2, Math.floor(position));
    const t = position - lo;
    const a = stop(name, lo);
    const b = stop(name, lo + 1);
    for (let c = 0; c < 3; c += 1) bytes[i * 4 + c] = Math.round(a[c] + (b[c] - a[c]) * t);
    bytes[i * 4 + 3] = 255;
  }
  return bytes;
}

const textureCache = new Map<string, THREE.DataTexture>();

/**
 * Shared 256x1 lookup texture (do not dispose; cached for the page lifetime).
 * Bytes are raw sRGB: our ShaderMaterials write them straight to the sRGB canvas.
 */
export function colormapTexture(name: string): THREE.DataTexture {
  let texture = textureCache.get(name);
  if (!texture) {
    texture = new THREE.DataTexture(colormapBytes(name), 256, 1, THREE.RGBAFormat);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    textureCache.set(name, texture);
  }
  return texture;
}

/** CSS linear-gradient for legends. */
export function colormapCss(name: string, direction = "90deg"): string {
  const count = (STOPS[name] ?? STOPS.viridis).length / 6;
  const parts: string[] = [];
  for (let i = 0; i < count; i += 3) {
    const [r, g, b] = stop(name, i);
    parts.push(`rgb(${r},${g},${b}) ${((i / (count - 1)) * 100).toFixed(1)}%`);
  }
  const [r, g, b] = stop(name, count - 1);
  parts.push(`rgb(${r},${g},${b}) 100%`);
  return `linear-gradient(${direction}, ${parts.join(", ")})`;
}

export function colormapColor(name: string, value: number): THREE.Color {
  const bytes = colormapBytes(name);
  const i = Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255) * 4;
  return new THREE.Color().setRGB(
    bytes[i] / 255,
    bytes[i + 1] / 255,
    bytes[i + 2] / 255,
    THREE.SRGBColorSpace,
  );
}

const lutCache = new Map<string, Uint8Array>();

/** CPU lookup with the same 256-entry LUT and linear filtering as `colormapTexture`. */
export function colormapRGB(name: string, t: number): [number, number, number] {
  let bytes = lutCache.get(name);
  if (!bytes) {
    bytes = colormapBytes(name);
    lutCache.set(name, bytes);
  }
  // texture(uColormap, vec2(t, .5)) with LinearFilter: texel centres at (i + .5) / 256
  const x = THREE.MathUtils.clamp(t, 0, 1) * 256 - 0.5;
  const i0 = THREE.MathUtils.clamp(Math.floor(x), 0, 255);
  const i1 = Math.min(255, i0 + 1);
  const f = THREE.MathUtils.clamp(x - Math.floor(x), 0, 1) * (x < 0 ? 0 : 1);
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) out[c] = Math.round(bytes[i0 * 4 + c]! * (1 - f) + bytes[i1 * 4 + c]! * f);
  return out;
}
