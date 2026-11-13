/**
 * Alignment / occlusion test layer (temporary until the real layers move onto the globe):
 * magenta domain edges, three translucent horizontal slices and a vertical curtain at v = 0.5
 * that reaches 300 m below ground (red part) so the depth proxy's occlusion is visible.
 * Every vertex is (u, v, AGL) and is placed on the GPU by the forward polynomial.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineSegments,
  Mesh,
  ShaderMaterial,
  GLSL3,
  LinearSRGBColorSpace,
} from "three";
import type { GeoMap } from "../geo/mapping";
import { geoPlaceGlsl, type GeoUniforms } from "./geoShader";
import { CURTAIN, SLICE_AGL_M, edgeSegments, gridSurface } from "./testGeometry";

function material(map: GeoMap, geo: GeoUniforms, color: number, alpha: number, opts: { depthTest: boolean; curtain?: boolean }): ShaderMaterial {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: alpha < 1,
    depthTest: opts.depthTest,
    depthWrite: false,
    side: DoubleSide,
    uniforms: { ...geo, uColor: { value: new Color().setHex(color, LinearSRGBColorSpace) } /* raw hex, the shader writes it as-is */, uAlpha: { value: alpha } },
    vertexShader: `${geoPlaceGlsl(map)}
out float vAgl;
void main() {
  vAgl = position.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(geoPlace(position), 1.0);
}`,
    fragmentShader: `precision highp float;
uniform vec3 uColor; uniform float uAlpha;
in float vAgl; out vec4 o;
void main() {
  vec3 c = ${opts.curtain ? "vAgl < 0.0 ? vec3(0.9, 0.05, 0.05) : uColor" : "uColor"};
  o = vec4(c, uAlpha);
}`,
  });
}

function surface(cols: number, rows: number, at: Parameters<typeof gridSurface>[2]): BufferGeometry {
  const { positions, indices } = gridSurface(cols, rows, at);
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(positions, 3));
  g.setIndex(new BufferAttribute(indices, 1));
  return g;
}

export function createTestLayer(map: GeoMap, geo: GeoUniforms, topM: number): Group {
  const group = new Group();
  group.name = "globe-test-layer";
  const segs: number[] = [];
  for (const line of edgeSegments(topM)) for (let i = 1; i < line.length; i++) segs.push(...line[i - 1]!, ...line[i]!);
  const edges = new BufferGeometry();
  edges.setAttribute("position", new BufferAttribute(new Float32Array(segs), 3));
  group.add(new LineSegments(edges, material(map, geo, 0xff00ff, 1, { depthTest: false })));
  const colors = [0x3b82f6, 0x22c55e, 0xeab308];
  SLICE_AGL_M.forEach((agl, n) => {
    const slice = new Mesh(surface(60, 60, (s, t) => [s, t, agl]), material(map, geo, colors[n]!, 0.35, { depthTest: true }));
    slice.name = "slice";
    group.add(slice);
  });
  // 60 columns -> chords <= 300 m along the domain; 1 row per 25 m like the nc layers
  const rows = (CURTAIN.topM - CURTAIN.bottomM) / 25;
  group.add(
    new Mesh(
      surface(60, rows, (s, t) => [s, CURTAIN.v, CURTAIN.bottomM + t * (CURTAIN.topM - CURTAIN.bottomM)]),
      material(map, geo, 0xf97316, 0.9, { depthTest: true, curtain: true }),
    ),
  );
  group.traverse((o) => (o.frustumCulled = false));
  return group;
}
