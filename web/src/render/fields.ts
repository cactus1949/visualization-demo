import * as THREE from "three";
import type { Manifest, VariableMeta } from "../data/manifest";

/**
 * Domain description shared by every layer.
 *
 * All layers live under one `root` group whose local units are kilometres:
 *   x = east  (−sx/2 .. sx/2), z = south (−sz/2 .. sz/2, north is −z), y = real height (km).
 * The vertical exaggeration is applied once as `root.scale.y`, so changing it never
 * rebuilds geometry or textures.
 */
export interface Domain {
  nx: number;
  ny: number;
  nz: number;
  sx: number;
  sz: number;
  /** model top in km (levels are cell centres, 0 .. top) */
  top: number;
  levels: number[];
}

export function domainOf(manifest: Manifest): Domain {
  const g = manifest.grid;
  const top = (g.level_interfaces_m?.[g.level_interfaces_m.length - 1] ?? 1000) / 1000;
  return {
    nx: g.nx,
    ny: g.ny,
    nz: g.nz,
    sx: ((g.nx - 1) * g.dx_m) / 1000,
    sz: ((g.ny - 1) * g.dy_m) / 1000,
    top,
    levels: g.levels_m,
  };
}

/** GLSL helper turning a root-local position (km) into 3D texture coordinates. */
export const GLSL_DOMAIN = /* glsl */ `
uniform vec3 uDomain;   // sx, sz, top (km)
uniform vec3 uGridN;    // nx, ny, nz
// x/z map to grid node indices (nodes sit on the box faces), height maps to cell centres:
// level i is at (i + 0.5) * dz, i.e. texture r = h / top exactly.
vec3 localToTex(vec3 p) {
  vec2 g = vec2(p.x / uDomain.x + 0.5, 0.5 - p.z / uDomain.y);
  vec2 t = (g * (uGridN.xy - 1.0) + 0.5) / uGridN.xy;
  return vec3(t, p.y / uDomain.z);
}
bool insideDomain(vec3 p) {
  return abs(p.x) <= uDomain.x * 0.5 + 1e-4 && abs(p.z) <= uDomain.y * 0.5 + 1e-4 &&
         p.y >= 0.0 && p.y <= uDomain.z;
}
`;

export function domainUniforms(domain: Domain) {
  return {
    uDomain: { value: new THREE.Vector3(domain.sx, domain.sz, domain.top) },
    uGridN: { value: new THREE.Vector3(domain.nx, domain.ny, domain.nz) },
  };
}

function make3D(data: Float32Array, d: Domain, format: THREE.AnyPixelFormat, channels = 1): THREE.Data3DTexture {
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i += 1) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
  const texture = new THREE.Data3DTexture(half, d.nx, d.ny, d.nz);
  texture.format = format;
  texture.type = THREE.HalfFloatType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** Wall time of the first upload of each named 3D texture, in milliseconds. */
export const textureUploadMs: Record<string, number> = {};

/** Uploads each variable once; layers only swap texture references afterwards. */
export class FieldTextures {
  private scalars = new Map<string, THREE.Data3DTexture>();
  private speedTexture: THREE.Data3DTexture | null = null;
  /** derived horizontal speed bytes (byte * maxSpeed / 255 = m/s) */
  speedValues: Float32Array | null = null;
  /** actual min/max of the derived horizontal speed (m/s) */
  speedRange: [number, number] = [0, 1];
  wind: THREE.Data3DTexture | null = null;

  constructor(readonly domain: Domain) {}

  scalar(name: string, data: Float32Array): THREE.Data3DTexture {
    let texture = this.scalars.get(name);
    if (!texture) {
      const t0 = performance.now();
      performance.mark(`atmos:upload:${name}:start`);
      texture = make3D(data, this.domain, THREE.RedFormat);
      performance.mark(`atmos:upload:${name}:end`);
      textureUploadMs[name] = performance.now() - t0;
      this.scalars.set(name, texture);
    }
    return texture;
  }

  /** u, v, w bytes packed in RGB (alpha = horizontal speed byte, 0..255 over 0..maxSpeed). */
  windTexture(
    u: Float32Array,
    v: Float32Array,
    w: Float32Array,
    maxSpeed: number,
  ): THREE.Data3DTexture {
    if (this.wind) return this.wind;
    const packed = new Float32Array(u.length * 4);
    for (let i = 0; i < u.length; i += 1) {
      const uu = u[i], vv = v[i];
      packed[i * 4] = uu; packed[i * 4 + 1] = vv; packed[i * 4 + 2] = w[i];
      packed[i * 4 + 3] = Math.hypot(uu, vv);
    }
    this.wind = make3D(packed, this.domain, THREE.RGBAFormat);
    return this.wind;
  }

  /** Horizontal speed as its own R8 texture (for slices), derived from u and v. */
  speed(u: Float32Array, v: Float32Array, maxSpeed: number) {
    if (this.speedTexture) return this.speedTexture;
    const values = new Float32Array(u.length);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < u.length; i += 1) {
      const uu = u[i], vv = v[i];
      const s = Math.hypot(uu, vv);
      if (s < lo) lo = s;
      if (s > hi) hi = s;
      values[i] = s;
    }
    this.speedRange = [lo, hi];
    this.speedValues = values;
    this.speedTexture = make3D(values, this.domain, THREE.RedFormat);
    return this.speedTexture;
  }

  dispose(): void {
    this.scalars.forEach((t) => t.dispose());
    this.scalars.clear();
    this.wind?.dispose();
    this.speedTexture?.dispose();
    this.wind = null;
    this.speedTexture = null;
  }
}

/**
 * Robust value range of physical floats in [start, end): the 2nd–98th percentile.
 * Levels (90k) are sorted directly; a full 3D field is systematically subsampled.
 */
export function floatRange(
  values: Float32Array,
  start: number,
  end: number,
  lowPct = 0.02,
  highPct = 0.98,
): [number, number] {
  const n = end - start;
  if (n <= 0) return [0, 1];
  const maxSample = 200_000;
  const sample: number[] = [];
  const count = Math.min(maxSample, n);
  const step = n / count;
  for (let i = 0; i < count; i += 1) {
    const value = values[start + Math.floor(i * step)]!;
    if (Number.isFinite(value)) sample.push(value);
  }
  if (!sample.length) return [0, 1];
  sample.sort((a, b) => a - b);
  const at = (p: number) => sample[Math.min(sample.length - 1, Math.max(0, Math.floor(p * (sample.length - 1))))]!;
  const lo = at(lowPct), hi = at(highPct);
  return [lo, hi > lo ? hi : lo + 1e-9];
}
