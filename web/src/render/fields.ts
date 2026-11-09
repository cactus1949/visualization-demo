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

/** value = byte * scale + offset (then 10^value when transform == log10). */
export function dequantize(meta: VariableMeta, byte: number): number {
  const value = byte * meta.scale + meta.offset;
  return meta.transform === "log10" ? Math.pow(10, value) : value;
}

function make3D(data: Uint8Array, d: Domain, format: THREE.AnyPixelFormat): THREE.Data3DTexture {
  const texture = new THREE.Data3DTexture(data, d.nx, d.ny, d.nz);
  texture.format = format;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** Uploads each variable once; layers only swap texture references afterwards. */
export class FieldTextures {
  private scalars = new Map<string, THREE.Data3DTexture>();
  private speedTexture: THREE.Data3DTexture | null = null;
  /** derived horizontal speed bytes (byte * maxSpeed / 255 = m/s) */
  speedBytes: Uint8Array | null = null;
  /** actual min/max of the derived horizontal speed (m/s) */
  speedRange: [number, number] = [0, 1];
  wind: THREE.Data3DTexture | null = null;

  constructor(readonly domain: Domain) {}

  scalar(name: string, data: Uint8Array): THREE.Data3DTexture {
    let texture = this.scalars.get(name);
    if (!texture) {
      texture = make3D(data, this.domain, THREE.RedFormat);
      this.scalars.set(name, texture);
    }
    return texture;
  }

  /** u, v, w bytes packed in RGB (alpha = horizontal speed byte, 0..255 over 0..maxSpeed). */
  windTexture(
    u: Uint8Array,
    v: Uint8Array,
    w: Uint8Array,
    uMeta: VariableMeta,
    vMeta: VariableMeta,
    maxSpeed: number,
  ): THREE.Data3DTexture {
    if (this.wind) return this.wind;
    const packed = new Uint8Array(u.length * 4);
    for (let i = 0; i < u.length; i += 1) {
      const uu = u[i] * uMeta.scale + uMeta.offset;
      const vv = v[i] * vMeta.scale + vMeta.offset;
      packed[i * 4] = u[i];
      packed[i * 4 + 1] = v[i];
      packed[i * 4 + 2] = w[i];
      packed[i * 4 + 3] = Math.min(255, Math.round((Math.hypot(uu, vv) / maxSpeed) * 255));
    }
    this.wind = make3D(packed, this.domain, THREE.RGBAFormat);
    return this.wind;
  }

  /** Horizontal speed as its own R8 texture (for slices), derived from u and v. */
  speed(u: Uint8Array, v: Uint8Array, uMeta: VariableMeta, vMeta: VariableMeta, maxSpeed: number) {
    if (this.speedTexture) return this.speedTexture;
    const bytes = new Uint8Array(u.length);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < u.length; i += 1) {
      const uu = u[i] * uMeta.scale + uMeta.offset;
      const vv = v[i] * vMeta.scale + vMeta.offset;
      const s = Math.hypot(uu, vv);
      if (s < lo) lo = s;
      if (s > hi) hi = s;
      bytes[i] = Math.min(255, Math.round((s / maxSpeed) * 255));
    }
    this.speedRange = [lo, hi];
    this.speedBytes = bytes;
    this.speedTexture = make3D(bytes, this.domain, THREE.RedFormat);
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
 * Robust value range of quantised bytes in [start, end): the 2nd–98th percentile via a
 * 256-bin histogram (exact for uint8 data, ~1 ms for a 300x300 level).
 */
export function byteRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  lowPct = 0.02,
  highPct = 0.98,
): [number, number] {
  const hist = new Uint32Array(256);
  for (let i = start; i < end; i += 1) hist[bytes[i]] += 1;
  const total = end - start;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  let foundLo = false;
  for (let b = 0; b < 256; b += 1) {
    acc += hist[b];
    if (!foundLo && acc >= total * lowPct) {
      lo = b;
      foundLo = true;
    }
    if (acc >= total * highPct) {
      hi = b;
      break;
    }
  }
  return [lo, Math.max(hi, lo + 1)];
}
