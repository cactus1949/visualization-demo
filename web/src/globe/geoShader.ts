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

/**
 * Root-local box km (first two tabs' layout: x east, z south, y height km) -> (u, v, AGL metres).
 * Needs `uniform vec3 uDomain` (sx, sz, top km; see GLSL_DOMAIN in render/fields.ts).
 */
export const BOX_TO_UVAGL_GLSL = /* glsl */ `
vec3 boxToUvAgl(vec3 p) {
  return vec3(p.x / uDomain.x + 0.5, 0.5 - p.z / uDomain.y, p.y * 1000.0);
}
`;

/**
 * three's logarithmic depth for custom ShaderMaterials (globe renderer runs with logarithmicDepthBuffer).
 * Vertex: declare with LOGDEPTH_VERTEX_PARS, call LOGDEPTH_VERTEX after gl_Position.
 * Fragment: declare with LOGDEPTH_FRAGMENT_PARS, run LOGDEPTH_FRAGMENT at the top of main().
 * gl_FragDepth is written even when depthWrite is false so the depth test matches the log buffer.
 */
export const LOGDEPTH_VERTEX_PARS = /* glsl */ `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
out float vFragDepth;
out float vIsPerspective;
#endif
`;
export const LOGDEPTH_VERTEX = /* glsl */ `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  vFragDepth = 1.0 + gl_Position.w;
  vIsPerspective = projectionMatrix[2][3] == -1.0 ? 1.0 : 0.0;
#endif
`;
export const LOGDEPTH_FRAGMENT_PARS = /* glsl */ `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
uniform float logDepthBufFC;
in float vFragDepth;
in float vIsPerspective;
#endif
`;
export const LOGDEPTH_FRAGMENT = /* glsl */ `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2(vFragDepth) * logDepthBufFC * 0.5;
#endif
`;
