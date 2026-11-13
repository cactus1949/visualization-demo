/**
 * GLSL placement shared by every three.js layer on the globe: a vertex given as
 * (u, v, AGL metres) goes to centre-ENU (units of map.enu_unit_m) through
 *   h = terrain * g(u, v) + k * AGL,  enu = forwardPoly(u, v, h / 1e4)
 * with g read from the per-column ground texture (manual bilinear, exact float32 texels).
 * `geoInverseGlsl` is the reverse (centre-ENU units -> u, v, h / 1e4) used by ray marchers.
 */
import { DataTexture, FloatType, NearestFilter, RedFormat, Vector3, type IUniform } from "three";
import type { GeoMap } from "../geo/mapping";
import type { GridField } from "../geo/placement";

export interface GeoUniforms {
  [name: string]: IUniform;
  uGeoFwd: IUniform<Vector3[]>;
  uGeoInv: IUniform<Vector3[]>;
  uGeoGround: IUniform<DataTexture>;
  uGeoTerrain: IUniform<number>;
  uGeoK: IUniform<number>;
}

/** One set per globe: layers share these objects, so terrain / k changes are a single uniform write. */
export function createGeoUniforms(map: GeoMap, ground: GridField): GeoUniforms {
  const tex = new DataTexture(ground.values, ground.nx, ground.ny, RedFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  const rows = (coef: number[][]) => map.terms.map((_, n) => new Vector3(coef[0]![n], coef[1]![n], coef[2]![n]));
  return {
    uGeoFwd: { value: rows(map.fwd) },
    uGeoInv: { value: rows(map.inv) },
    uGeoGround: { value: tex },
    uGeoTerrain: { value: 0 },
    uGeoK: { value: 1 },
  };
}

const POW = ["1.0", "a", "a2", "a3"];
const POWB = ["1.0", "b", "b2", "b3"];
const POWC = ["1.0", "c"];

function polySum(map: GeoMap, coef: string): string {
  return map.terms.map(([i, j, k], idx) => `${coef}[${idx}] * (${POW[i]} * ${POWB[j]} * ${POWC[k]})`).join(" +\n    ");
}

/** Ground uniforms + `float geoGround(vec2 uv)`. */
export const GEO_GROUND_GLSL = /* glsl */ `
uniform sampler2D uGeoGround;
uniform float uGeoTerrain;
uniform float uGeoK;
float geoGround(vec2 uv) {
  ivec2 size = textureSize(uGeoGround, 0);
  vec2 f = clamp(uv, 0.0, 1.0) * vec2(size - 1);
  ivec2 i0 = min(ivec2(floor(f)), size - 2);
  vec2 t = f - vec2(i0);
  float g00 = texelFetch(uGeoGround, i0, 0).r, g10 = texelFetch(uGeoGround, i0 + ivec2(1, 0), 0).r;
  float g01 = texelFetch(uGeoGround, i0 + ivec2(0, 1), 0).r, g11 = texelFetch(uGeoGround, i0 + ivec2(1, 1), 0).r;
  return mix(mix(g00, g10, t.x), mix(g01, g11, t.x), t.y);
}
`;

/** GLSL3 declarations + `vec3 geoPlace(vec3 uvAgl)`; prepend to a vertex shader. */
export function geoPlaceGlsl(map: GeoMap): string {
  return `
uniform vec3 uGeoFwd[${map.terms.length}];
${GEO_GROUND_GLSL}
vec3 geoForward(float a, float b, float c) {
  float a2 = a * a, a3 = a2 * a, b2 = b * b, b3 = b2 * b;
  return ${polySum(map, "uGeoFwd")};
}
vec3 geoPlace(vec3 uvAgl) {
  float h = uGeoTerrain * geoGround(uvAgl.xy) + uGeoK * uvAgl.z;
  return geoForward(uvAgl.x, uvAgl.y, h / ${(1e4).toFixed(1)});
}
`;
}

/**
 * GLSL3 `vec3 geoInverse(vec3 enu)`: centre-ENU in scene units (map.enu_unit_m) -> (u, v, h / 1e4).
 * Same terms and coefficients as `polyInverse` in geo/mapping.ts (whose input is metres / enu_unit_m,
 * i.e. exactly the scene units). Ground helpers are not included; add GEO_GROUND_GLSL when needed.
 */
export function geoInverseGlsl(map: GeoMap): string {
  return `
uniform vec3 uGeoInv[${map.terms.length}];
vec3 geoInverse(vec3 enu) {
  float a = enu.x, b = enu.y, c = enu.z;
  float a2 = a * a, a3 = a2 * a, b2 = b * b, b3 = b2 * b;
  return ${polySum(map, "uGeoInv")};
}
`;
}
