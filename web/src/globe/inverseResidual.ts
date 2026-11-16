/**
 * Debug measurement: residual of the production `geoInverse` GLSL on the GPU. Exact float64 ENU
 * points go up as float32, the shader returns (u, v, h / 1e4) into a float target, and the CPU
 * maps that back with exact float64 geodesy: error = |exactEnu(u', v', h') − input| in metres.
 */
import {
  DataTexture, FloatType, GLSL3, Mesh, NearestFilter, OrthographicCamera, PlaneGeometry, RGBAFormat,
  Scene, ShaderMaterial, WebGLRenderTarget, type WebGLRenderer,
} from "three";
import { enuFrameAt, exactEnu, type GeoGrid, type GeoMap } from "../geo/mapping";
import { geoInverseGlsl, type GeoUniforms } from "./geoShader";

export interface ResidualStats {
  count: number;
  max_m: number;
  mean_m: number;
  p50_m: number;
  p90_m: number;
  p99_m: number;
  /** horizontal / vertical split of the max, metres */
  max_horizontal_m: number;
  max_vertical_m: number;
  byHeight: Record<string, { max_m: number; p99_m: number }>;
  histogram_mm: Record<string, number>;
  worst: { u: number; v: number; h: number };
}

export const RESIDUAL_HEIGHTS_M = [-50, 0, 500, 1000, 3000, 5000, 10000];

export function measureInverseResidualGpu(
  renderer: WebGLRenderer, grid: GeoGrid, map: GeoMap, geo: GeoUniforms, samples = 101, heights = RESIDUAL_HEIGHTS_M,
): ResidualStats {
  const frame = enuFrameAt(map.lon0, map.lat0);
  const w = samples, h = samples * heights.length;
  const input = new Float32Array(w * h * 4);
  const pts: Array<{ u: number; v: number; h: number; e: number[] }> = [];
  for (let hi = 0; hi < heights.length; hi++) for (let j = 0; j < samples; j++) for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1), v = j / (samples - 1), hm = heights[hi]!;
    const e = exactEnu(grid, frame, u, v, hm);
    const o = ((hi * samples + j) * w + i) * 4;
    input.set([e[0] / map.enu_unit_m, e[1] / map.enu_unit_m, e[2] / map.enu_unit_m, 1], o);
    pts.push({ u, v, h: hm, e });
  }
  const tex = new DataTexture(input, w, h, RGBAFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.needsUpdate = true;
  const target = new WebGLRenderTarget(w, h, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false });
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { uGeoInv: geo.uGeoInv, uPoints: { value: tex } },
    vertexShader: `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `precision highp float;
${geoInverseGlsl(map)}
uniform sampler2D uPoints;
out vec4 outColor;
void main() { outColor = vec4(geoInverse(texelFetch(uPoints, ivec2(gl_FragCoord.xy), 0).xyz), 1.0); }`,
  });
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new Scene();
  scene.add(quad);
  const out = new Float32Array(w * h * 4);
  renderer.setRenderTarget(target);
  renderer.render(scene, new OrthographicCamera());
  renderer.readRenderTargetPixels(target, 0, 0, w, h, out);
  renderer.setRenderTarget(null);
  tex.dispose(); target.dispose(); material.dispose(); quad.geometry.dispose();

  const errs: number[] = [];
  const perH = new Map<number, number[]>();
  let maxIdx = 0, maxH = 0, maxV = 0;
  pts.forEach((p, n) => {
    const u = out[n * 4]!, v = out[n * 4 + 1]!, hh = out[n * 4 + 2]! * 1e4;
    const back = exactEnu(grid, frame, u, v, hh);
    const dx = back[0] - p.e[0]!, dy = back[1] - p.e[1]!, dz = back[2] - p.e[2]!;
    const err = Math.hypot(dx, dy, dz);
    errs.push(err);
    if (err > errs[maxIdx]!) maxIdx = n;
    maxH = Math.max(maxH, Math.hypot(dx, dy));
    maxV = Math.max(maxV, Math.abs(dz));
    (perH.get(p.h) ?? perH.set(p.h, []).get(p.h)!).push(err);
  });
  const q = (a: number[], f: number) => a[Math.min(a.length - 1, Math.floor(f * (a.length - 1)))]!;
  const sorted = [...errs].sort((a, b) => a - b);
  const hist: Record<string, number> = { "<1": 0, "1-2": 0, "2-4": 0, "4-6": 0, "6-8": 0, "8-10": 0, ">=10": 0 };
  for (const e of errs) {
    const mm = e * 1000;
    hist[mm < 1 ? "<1" : mm < 2 ? "1-2" : mm < 4 ? "2-4" : mm < 6 ? "4-6" : mm < 8 ? "6-8" : mm < 10 ? "8-10" : ">=10"]! += 1;
  }
  const byHeight: ResidualStats["byHeight"] = {};
  for (const [hm, a] of perH) { a.sort((x, y) => x - y); byHeight[String(hm)] = { max_m: a[a.length - 1]!, p99_m: q(a, 0.99) }; }
  const worst = pts[maxIdx]!;
  return {
    count: errs.length, max_m: sorted[sorted.length - 1]!, mean_m: errs.reduce((a, b) => a + b, 0) / errs.length,
    p50_m: q(sorted, 0.5), p90_m: q(sorted, 0.9), p99_m: q(sorted, 0.99), max_horizontal_m: maxH, max_vertical_m: maxV,
    byHeight, histogram_mm: hist, worst: { u: worst.u, v: worst.v, h: worst.h },
  };
}
