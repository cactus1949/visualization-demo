import * as THREE from "three";
import { colormapTexture } from "./colormaps";
import { GLSL_DOMAIN, domainUniforms, type Domain } from "./fields";
import type { ScalarBinding } from "./slices";

/**
 * Raymarched volume (off by default). Works in root-local space: the ray from the camera
 * (transformed into root space every frame) is intersected with the domain box, then
 * marched front-to-back with jitter and early exit.
 */
const vertexShader = /* glsl */ `
out vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;
${GLSL_DOMAIN}
uniform sampler3D uField;
uniform sampler2D uColormap;
uniform vec3 uCameraLocal;
uniform float uScale;
uniform float uOffset;
uniform float uMin;
uniform float uMax;
uniform float uThreshold;
uniform float uOpacity;
uniform float uSteps;
in vec3 vLocal;
out vec4 outColor;

vec2 hitBox(vec3 origin, vec3 dir, vec3 lo, vec3 hi) {
  vec3 inv = 1.0 / dir;
  vec3 t0 = (lo - origin) * inv;
  vec3 t1 = (hi - origin) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

void main() {
  vec3 dir = normalize(vLocal - uCameraLocal);
  vec3 lo = vec3(-uDomain.x * 0.5, 0.0, -uDomain.y * 0.5);
  vec3 hi = vec3(uDomain.x * 0.5, uDomain.z, uDomain.y * 0.5);
  vec2 t = hitBox(uCameraLocal, dir, lo, hi);
  t.x = max(t.x, 0.0);
  if (t.x >= t.y) discard;
  float dt = (t.y - t.x) / uSteps;
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec4 acc = vec4(0.0);
  for (float i = 0.0; i < 256.0; i += 1.0) {
    if (i >= uSteps || acc.a > 0.97) break;
    vec3 p = uCameraLocal + dir * (t.x + (i + jitter) * dt);
    float value = texture(uField, localToTex(p)).r * 255.0 * uScale + uOffset;
    float n = clamp((value - uMin) / max(uMax - uMin, 1e-9), 0.0, 1.0);
    if (n < uThreshold) continue;
    vec3 c = texture(uColormap, vec2(n, 0.5)).rgb;
    float a = uOpacity * smoothstep(uThreshold, 1.0, n) * dt * 6.0;
    acc.rgb += (1.0 - acc.a) * a * c;
    acc.a += (1.0 - acc.a) * a;
  }
  if (acc.a < 0.003) discard;
  outColor = vec4(acc.rgb / acc.a, acc.a);
}
`;

export class VolumeLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly inverse = new THREE.Matrix4();

  constructor(domain: Domain) {
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        ...domainUniforms(domain),
        uField: { value: null },
        uColormap: { value: colormapTexture("magma") },
        uCameraLocal: { value: new THREE.Vector3() },
        uScale: { value: 1 },
        uOffset: { value: 0 },
        uMin: { value: 0 },
        uMax: { value: 1 },
        uThreshold: { value: 0.15 },
        uOpacity: { value: 0.6 },
        uSteps: { value: 128 },
      },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const box = new THREE.BoxGeometry(domain.sx, domain.top, domain.sz).translate(
      0,
      domain.top / 2,
      0,
    );
    this.mesh = new THREE.Mesh(box, this.material);
    this.mesh.renderOrder = 5;
    this.mesh.name = "volume";
  }

  bind(field: ScalarBinding, colormap: string, min: number, max: number): void {
    const u = this.material.uniforms;
    u.uField.value = field.texture;
    u.uScale.value = field.scale;
    u.uOffset.value = field.offset;
    u.uColormap.value = colormapTexture(colormap);
    u.uMin.value = min;
    u.uMax.value = max;
  }

  /** Keep the camera position in root-local space (root is scaled in y). */
  update(camera: THREE.Camera, root: THREE.Object3D): void {
    this.inverse.copy(root.matrixWorld).invert();
    this.material.uniforms.uCameraLocal.value.copy(camera.position).applyMatrix4(this.inverse);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
