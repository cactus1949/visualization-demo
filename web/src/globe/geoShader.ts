import { DataTexture, FloatType, NearestFilter, RedFormat, Vector3, type IUniform } from "three";
import type { GeoMap } from "../geo/mapping";
import type { GridField } from "../geo/placement";

export interface GeoUniforms {
  [name: string]: IUniform;
  uGeoFwd: IUniform<Vector3[]>;
  uGeoGround: IUniform<DataTexture>;
  uGeoTerrain: IUniform<number>;
  uGeoK: IUniform<number>;
}

export function createGeoUniforms(map: GeoMap, ground: GridField): GeoUniforms {
  const tex = new DataTexture(ground.values, ground.nx, ground.ny, RedFormat, FloatType);
  tex.minFilter = tex.magFilter = NearestFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return {
    uGeoFwd: { value: map.terms.map((_, n) => new Vector3(map.fwd[0]![n], map.fwd[1]![n], map.fwd[2]![n])) },
    uGeoGround: { value: tex },
    uGeoTerrain: { value: 0 },
    uGeoK: { value: 1 },
  };
}

const POW = ["1.0", "a", "a2", "a3"];
const POWB = ["1.0", "b", "b2", "b3"];
const POWC = ["1.0", "c"];

export function geoPlaceGlsl(map: GeoMap): string {
  const n = map.terms.length;
  const sum = map.terms.map(([i, j, k], idx) => `uGeoFwd[${idx}] * (${POW[i]} * ${POWB[j]} * ${POWC[k]})`).join(" +\n    ");
  return `
uniform vec3 uGeoFwd[${n}];
uniform sampler2D uGeoGround;
uniform float uGeoTerrain;
uniform float uGeoK;
vec3 geoForward(float a, float b, float c) {
  float a2 = a * a, a3 = a2 * a, b2 = b * b, b3 = b2 * b;
  return ${sum};
}
float geoGround(vec2 uv) {
  ivec2 size = textureSize(uGeoGround, 0);
  vec2 f = clamp(uv, 0.0, 1.0) * vec2(size - 1);
  ivec2 i0 = min(ivec2(floor(f)), size - 2);
  vec2 t = f - vec2(i0);
  float g00 = texelFetch(uGeoGround, i0, 0).r, g10 = texelFetch(uGeoGround, i0 + ivec2(1, 0), 0).r;
  float g01 = texelFetch(uGeoGround, i0 + ivec2(0, 1), 0).r, g11 = texelFetch(uGeoGround, i0 + ivec2(1, 1), 0).r;
  return mix(mix(g00, g10, t.x), mix(g01, g11, t.x), t.y);
}
vec3 geoPlace(vec3 uvAgl) {
  float h = uGeoTerrain * geoGround(uvAgl.xy) + uGeoK * uvAgl.z;
  return geoForward(uvAgl.x, uvAgl.y, h / 10000.0);
}
`;
}

export function geoInverseGlsl(map: GeoMap): string {
  const n = map.terms.length;
  const sum = map.terms.map(([i, j, k], idx) => `uGeoInv[${idx}] * (${POW[i]} * ${POWB[j]} * ${POWC[k]})`).join(" +\n    ");
  return `
uniform vec3 uGeoInv[${n}];
vec3 geoInverse(vec3 enu) {
  float a = enu.x / ${map.enu_unit_m.toFixed(8)}, b = enu.y / ${map.enu_unit_m.toFixed(8)}, c = enu.z / ${map.enu_unit_m.toFixed(8)};
  float a2 = a * a, a3 = a2 * a, b2 = b * b, b3 = b2 * b;
  return ${sum};
}
`;
}
