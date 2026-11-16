/**
 * Debug only (dev or ?globeDebug=1): read back what the globe section shaders produce at a few
 * screen points: the sampled field value, the interpolated box-km position (vLocal) and the
 * interpolated ENU position the vertex shader placed. Run from a frame hook (afterRender).
 */
import * as THREE from "three";
import { GLSL_DOMAIN } from "../fields";

const fragment = /* glsl */ `
precision highp float;
precision highp sampler3D;
${GLSL_DOMAIN}
uniform sampler3D uField;
uniform float uPass;
in vec3 vLocal;
in vec3 vDbgEnu;
out vec4 outColor;
void main() {
  if (!insideDomain(vLocal)) discard;
  outColor = uPass < 0.5 ? vec4(texture(uField, localToTex(vLocal)).r, vLocal) : vec4(vDbgEnu, 1.0);
}
`;

export interface SectionSample {
  /** normalised viewport position (0..1, y down) */
  at: [number, number];
  value: number;
  local: [number, number, number];
  enu: [number, number, number];
}

export function readSectionSamples(
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  meshes: THREE.Mesh[],
  points: [number, number][],
): SectionSample[] {
  const w = renderer.domElement.width, h = renderer.domElement.height;
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
  const scene = new THREE.Scene();
  const mats: THREE.ShaderMaterial[] = [];
  for (const m of meshes) {
    const src = m.material as THREE.ShaderMaterial;
    if (!src.vertexShader.includes("geoPlace(")) continue;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: src.vertexShader
        .replace("out vec3 vLocal;", "out vec3 vLocal;\nout vec3 vDbgEnu;")
        .replace("vec3 enu = geoPlace(boxToUvAgl(boxKm));", "vec3 enu = geoPlace(boxToUvAgl(boxKm));\n  vDbgEnu = enu;"),
      fragmentShader: fragment,
      uniforms: { ...src.uniforms, uPass: { value: 0 } },
      side: THREE.DoubleSide,
    });
    mats.push(mat);
    const proxy = new THREE.Mesh(m.geometry, mat);
    proxy.matrixAutoUpdate = false;
    proxy.matrix.copy(m.matrixWorld);
    proxy.frustumCulled = false;
    scene.add(proxy);
  }
  const prev = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const out: SectionSample[] = points.map((at) => ({ at, value: NaN, local: [NaN, NaN, NaN], enu: [NaN, NaN, NaN] }));
  const px = new Float32Array(4);
  const camAuto = camera.matrixWorldAutoUpdate;
  camera.matrixWorldAutoUpdate = false;
  try {
    for (const pass of [0, 1]) {
      for (const m of mats) m.uniforms.uPass!.value = pass;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      points.forEach(([x, y], i) => {
        const ix = Math.min(w - 1, Math.max(0, Math.floor(x * w)));
        const iy = Math.min(h - 1, Math.max(0, Math.floor((1 - y) * h)));
        renderer.readRenderTargetPixels(rt, ix, iy, 1, 1, px);
        if (pass === 0) {
          out[i]!.value = px[0]!;
          out[i]!.local = [px[1]!, px[2]!, px[3]!];
        } else if (px[3]! > 0.5) {
          out[i]!.enu = [px[0]!, px[1]!, px[2]!];
        } else {
          out[i]!.value = NaN;
        }
      });
    }
  } finally {
    camera.matrixWorldAutoUpdate = camAuto;
    renderer.setRenderTarget(prev);
    renderer.setClearColor(prevClear, prevAlpha);
    rt.dispose();
    for (const m of mats) m.dispose();
  }
  return out.filter((s) => Number.isFinite(s.value) && Number.isFinite(s.enu[0]));
}
