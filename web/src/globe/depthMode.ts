/**
 * three's near/far for the globe overlay, and which depth encoding it uses.
 *
 * - legacy: the PR ① behaviour (near = sphere distance or 1 m, far = sphere back), kept for comparison.
 * - near: near / far from the camera's distance to the overlay's ENU bounding box (nearest and
 *   farthest corner), so a camera 10-20 km away gets a near plane of kilometres, not 1 m.
 * - log: the same tight near / far plus three's logarithmic depth buffer, so depth precision stays
 *   relative to distance even when the camera is inside the box (near falls back to 1 m there).
 *
 * Pure functions, units are whatever the caller passes (the overlay uses ENU units).
 */
export type GlobeDepthMode = "legacy" | "near" | "log";

export const DEFAULT_DEPTH_MODE: GlobeDepthMode = "log";

export function depthModeFromQuery(search = ""): GlobeDepthMode {
  const value = new URLSearchParams(search).get("globeDepth");
  if (value === "legacy" || value === "near" || value === "log") return value;
  // ③'s public switch: ?globeDepth=linear → box near/far + a linear depth buffer
  if (value === "linear") return "near";
  return DEFAULT_DEPTH_MODE;
}

export function depthEncodingOf(mode: GlobeDepthMode): "log" | "linear" {
  return mode === "log" ? "log" : "linear";
}

export type Vec3 = [number, number, number];

export interface Box3Like {
  min: Vec3;
  max: Vec3;
}

/** Distance from p to the nearest point of the box (0 inside) and to its farthest corner. */
export function boxDistances(p: Vec3, box: Box3Like): { nearest: number; farthest: number } {
  let n2 = 0, f2 = 0;
  for (let c = 0; c < 3; c++) {
    const lo = box.min[c]!, hi = box.max[c]!, x = p[c]!;
    const d = x < lo ? lo - x : x > hi ? x - hi : 0;
    n2 += d * d;
    const far = Math.max(Math.abs(x - lo), Math.abs(x - hi));
    f2 += far * far;
  }
  return { nearest: Math.sqrt(n2), farthest: Math.sqrt(f2) };
}

export interface FrustumInput {
  mode: GlobeDepthMode;
  camera: Vec3;
  box: Box3Like;
  /** legacy only: bounding sphere of the same content */
  sphere: { center: Vec3; radius: number };
  /** smallest near plane, same units */
  minNear: number;
}

/**
 * near / far in the caller's units. The box distance is the distance to the box, not to the content,
 * so it never clips anything inside the box; 0.98 / 1.02 only absorb rounding.
 */
export function frustumDistances({ mode, camera, box, sphere, minNear }: FrustumInput): { near: number; far: number } {
  if (mode === "legacy") {
    const d = Math.hypot(camera[0] - sphere.center[0], camera[1] - sphere.center[1], camera[2] - sphere.center[2]);
    return { near: Math.max(d - sphere.radius, minNear), far: d + sphere.radius };
  }
  const { nearest, farthest } = boxDistances(camera, box);
  const near = Math.max(nearest * 0.98, minNear);
  return { near, far: Math.max(farthest * 1.02, near * 2) };
}

/**
 * Smallest depth difference a 24-bit depth buffer can resolve at view distance z (same units as near/far).
 * Standard: dz = z^2 (f - n) / (f n 2^24). Log (three: log2(1 + w) / log2(1 + far)): dz = (1 + z) ln(1 + f) / 2^24.
 */
export function depthResolution(mode: GlobeDepthMode, z: number, near: number, far: number, bits = 24): number {
  const steps = 2 ** bits;
  if (mode === "log") return ((1 + z) * Math.log(1 + far)) / steps;
  return (z * z * (far - near)) / (far * near * steps);
}
