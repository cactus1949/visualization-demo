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
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
out float vFragDepth;
out float vIsPerspective;
bool isPerspectiveMatrix(const in mat4 m) { return m[2][3] == -1.0; }
#endif
out float vAgl;
void main() {
  vAgl = position.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(geoPlace(position), 1.0);
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  vFragDepth = 1.0 + gl_Position.w;
  vIsPerspective = float(isPerspectiveMatrix(projectionMatrix));
#endif
}`,
    fragmentShader: `precision highp float;
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
uniform float logDepthBufFC;
in float vFragDepth;
in float vIsPerspective;
#endif
uniform vec3 uColor; uniform float uAlpha;
in float vAgl; out vec4 o;
void main() {
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  // write gl_FragDepth even when depthWrite is false, so the depth test matches the log buffer
  gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2(vFragDepth) * logDepthBufFC * 0.5;
#endif
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

export function createTestLayer(map: GeoMap, geo: GeoUniforms, topM: number, faceAglM = 50): Group {
  const group = new Group();
  group.name = "globe-test-layer";
  const segs: number[] = [];
  for (const line of edgeSegments(topM)) for (let i = 1; i < line.length; i++) segs.push(...line[i - 1]!, ...line[i]!);
  const edges = new BufferGeometry();
  edges.setAttribute("position", new BufferAttribute(new Float32Array(segs), 3));
  group.add(new LineSegments(edges, material(map, geo, 0xff00ff, 1, { depthTest: false })));
  const debugFace = new Mesh(surface(80, 80, (s, t) => [s, t, faceAglM]), material(map, geo, 0x00d4ff, 1, { depthTest: true }));
  debugFace.name = "depth-test-face"; // depth-precision check only, off by default
  debugFace.visible = false;
  group.add(debugFace);
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
