/**
 * Current encoding: f16 / u8 / u16 (+ log10, log1p, signed_sqrt), Brotli via HTTP
 * Content-Encoding. Delete this file to drop the format (see services/README.md).
 */
import { count, fetchBytes, type Codec } from "./types";

const HALF_TO_FLOAT = new Float32Array(65536);
for (let h = 0; h < 65536; h += 1) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const frac = h & 0x3ff;
  HALF_TO_FLOAT[h] =
    exp === 0
      ? sign * Math.pow(2, -14) * (frac / 1024)
      : exp === 31
        ? frac
          ? NaN
          : sign * Infinity
        : sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

const codec: Codec = {
  id: "current",
  encodings: ["f16", "u8_linear", "u8_log10", "u8_int", "u8_signed_sqrt", "u16_linear", "u16_log10", "u16_signed_sqrt", "u8_log1p", "u16_log1p"],
  async load(base, meta, _name, signal) {
    return { bytes: await fetchBytes(base + meta.file, signal) };
  },
  decode({ bytes }, meta) {
    const n = count(meta);
    const out = new Float32Array(n);
    if (meta.dtype === "float16") {
      const h = new Uint16Array(bytes, 0, n);
      for (let i = 0; i < n; i += 1) out[i] = HALF_TO_FLOAT[h[i]!]!;
      return out;
    }
    const q = meta.dtype === "uint16" ? new Uint16Array(bytes, 0, n) : new Uint8Array(bytes, 0, n);
    const perLevel = meta.range_scope === "per_level" && meta.shape.length >= 3;
    const levels = perLevel ? meta.shape[0]! : 1;
    const stride = perLevel ? n / levels : n;
    const tr = meta.transform;
    // Exporter reserves the top code for missing cells only when the variable has any (nan_code in the manifest).
    const nanCode = meta.nan_code;
    for (let z = 0; z < levels; z += 1) {
      const scale = perLevel ? meta.level_scale![z]! : meta.scale!;
      const offset = perLevel ? meta.level_offset![z]! : meta.offset!;
      const start = z * stride;
      const end = start + stride;
      if (!tr) for (let i = start; i < end; i += 1) out[i] = q[i]! * scale + offset;
      else
        for (let i = start; i < end; i += 1) {
          const v = q[i]! * scale + offset;
          out[i] = tr === "log10" ? Math.pow(10, v) : tr === "log1p" ? Math.expm1(v) : Math.sign(v) * v * v;
        }
      if (nanCode !== undefined) for (let i = start; i < end; i += 1) if (q[i] === nanCode) out[i] = Number.NaN;
    }
    return out;
  },
  half({ bytes }, meta) {
    return meta.dtype === "float16" ? new Uint16Array(bytes.slice(0, count(meta) * 2)) : null;
  },
};

export default codec;
