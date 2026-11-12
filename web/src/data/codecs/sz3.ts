/**
 * SZ3 format: `encoding: "sz3"` (WASM decode, T1L packs) and `encoding: "derived"`
 * (fields the SZ3 exporter does not store and the browser recomputes, same formulas as
 * pipeline/sz3pipe/build_sz3.py). Delete this file and codecs/sz3/ to drop the format.
 */
import { decodeSz3, ensureSz3, type Sz3Index } from "./sz3/decoder";
import { count, fetchBytes, type Codec } from "./types";

interface DeriveSpec {
  op: "copy" | "profile" | "gust";
  from?: string;
  coef?: number;
  exponent?: number;
  ztop_m?: number;
  levels_m?: number[];
  u?: string;
  v?: string;
  sigma?: string;
}

const codec: Codec = {
  id: "sz3",
  encodings: ["sz3", "derived"],
  async load(base, meta) {
    if (meta.encoding === "derived") return { bytes: new ArrayBuffer(0) };
    const indexName = meta.index_file || meta.file.replace(/\.sz3pack$/, ".json");
    const [bytes, index] = await Promise.all([
      fetchBytes(base + meta.file),
      fetch(base + indexName).then((r) => {
        if (!r.ok) throw new Error(`无法加载 ${base + indexName}: ${r.status}`);
        return r.json() as Promise<Sz3Index>;
      }),
    ]);
    return { bytes, extra: index };
  },
  async decode(p, meta, env) {
    if (meta.encoding !== "derived") {
      await ensureSz3();
      return decodeSz3(new Uint8Array(p.bytes), p.extra as Sz3Index);
    }
    const d = (meta as unknown as { derive: DeriveSpec }).derive;
    const n = count(meta);
    const out = new Float32Array(n);
    if (d.op === "copy") {
      out.set(await env.values(d.from!));
    } else if (d.op === "profile") {
      // value = coef * from(lat, lon) * (1 - z / ztop) ^ exponent
      const src = await env.values(d.from!);
      const plane = src.length;
      const levels = d.levels_m ?? env.manifest.grid.levels_m;
      const ztop = d.ztop_m ?? env.manifest.grid.level_interfaces_m.at(-1)!;
      for (let z = 0; z < levels.length; z += 1) {
        const k = d.coef! * Math.pow(Math.max(1 - levels[z]! / ztop, 0), d.exponent ?? 1 / 3);
        for (let i = 0; i < plane; i += 1) out[z * plane + i] = k * src[i]!;
      }
    } else if (d.op === "gust") {
      // value = hypot(u, v) + 2 * sigma
      const [u, v, s] = await Promise.all([env.values(d.u!), env.values(d.v!), env.values(d.sigma!)]);
      for (let i = 0; i < n; i += 1) out[i] = Math.hypot(u[i]!, v[i]!) + 2 * s[i]!;
    } else {
      throw new Error(`未知派生方式 ${String(d.op)}`);
    }
    return out;
  },
};

export default codec;
