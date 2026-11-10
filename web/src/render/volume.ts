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
uniform float uLog;
uniform float uMin;
uniform float uMax;
uniform float uFilterMin;
uniform float uFilterMax;
uniform float uFilterEnable;
uniform float uThreshold;
uniform float uOpacity;
uniform float uSteps;
uniform sampler2D uDepth;
uniform float uDepthValid;
uniform vec2 uResolution;
uniform mat4 uInvProjection;
uniform mat4 uInvView;
uniform mat4 uRootInverse;
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
  // The depth pre-pass contains only opaque scene geometry. Reconstruct its world position
  // from the non-reversed-Z depth value, then convert it through the root inverse so the
  // vertical exaggeration is removed before measuring distance along this root-local ray.
  float tEnd = t.y;
  if (uDepthValid > 0.5) {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float depth = texture(uDepth, uv).r;
    if (depth < 0.999999) {
      vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 viewPos = uInvProjection * ndc;
      viewPos /= max(viewPos.w, 1e-8);
      vec4 worldPos = uInvView * viewPos;
      vec3 depthLocal = (uRootInverse * worldPos).xyz;
      float tScene = dot(depthLocal - uCameraLocal, dir);
      tEnd = min(tEnd, tScene - 1e-4);
    }
  }
  if (t.x >= tEnd) discard;
  float dt = (tEnd - t.x) / uSteps;
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec4 acc = vec4(0.0);
  for (float i = 0.0; i < 256.0; i += 1.0) {
    if (i >= uSteps || acc.a > 0.97) break;
    vec3 p = uCameraLocal + dir * (t.x + (i + jitter) * dt);
    float raw = texture(uField, localToTex(p)).r * 255.0 * uScale + uOffset;
    float value = uLog > 0.5 ? pow(10.0, raw) : raw;
    // The physical filter is independent from uMin/uMax, which remain the stable colour range.
    if (uFilterEnable > 0.5 && (value < uFilterMin - 1e-6 || value > uFilterMax + 1e-6)) continue;
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
  private readonly depthTarget: THREE.WebGLRenderTarget;
  private readonly invProjection = new THREE.Matrix4();
  private readonly invView = new THREE.Matrix4();
  private readonly hiddenVisibility: boolean[] = [];
  private depthWidth = 1;
  private depthHeight = 1;

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
        uLog: { value: 0 },
        uMin: { value: 0 },
        uMax: { value: 1 },
        uFilterMin: { value: 0 },
        uFilterMax: { value: 1 },
        uFilterEnable: { value: 0 },
        uThreshold: { value: 0.15 },
        uOpacity: { value: 0.6 },
        uSteps: { value: 128 },
        uDepth: { value: null },
        uDepthValid: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uInvProjection: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uRootInverse: { value: new THREE.Matrix4() },
      },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    const box = new THREE.BoxGeometry(domain.sx, domain.top, domain.sz).translate(
      0,
      domain.top / 2,
      0,
    );
    this.mesh = new THREE.Mesh(box, this.material);
    this.mesh.renderOrder = 5;
    this.mesh.name = "volume";
    this.depthTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.depthTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.depthTarget.depthTexture.format = THREE.DepthFormat;
    this.depthTarget.depthTexture.minFilter = THREE.NearestFilter;
    this.depthTarget.depthTexture.magFilter = THREE.NearestFilter;
    this.material.uniforms.uDepth.value = this.depthTarget.depthTexture;
  }

  bind(field: ScalarBinding, colormap: string, min: number, max: number): void {
    const u = this.material.uniforms;
    u.uField.value = field.texture;
    u.uScale.value = field.scale;
    u.uOffset.value = field.offset;
    u.uLog.value = field.log10 ? 1 : 0;
    u.uColormap.value = colormapTexture(colormap);
    u.uMin.value = min;
    u.uMax.value = max;
  }

  setFilter(min: number, max: number, enabled: boolean): void {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    this.material.uniforms.uFilterMin.value = lo;
    this.material.uniforms.uFilterMax.value = hi;
    this.material.uniforms.uFilterEnable.value = enabled ? 1 : 0;
  }

  resize(renderer: THREE.WebGLRenderer): void {
    const width = Math.max(1, renderer.domElement.width);
    const height = Math.max(1, renderer.domElement.height);
    if (width !== this.depthWidth || height !== this.depthHeight) {
      this.depthTarget.setSize(width, height);
      this.depthWidth = width;
      this.depthHeight = height;
    }
    this.material.uniforms.uResolution.value.set(width, height);
  }

  /** Render opaque geometry into a depth texture, temporarily hiding transparent layers. */
  captureDepth(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    hide: THREE.Object3D[],
  ): void {
    this.resize(renderer);
    const meshVisible = this.mesh.visible;
    this.mesh.visible = false;
    for (let i = 0; i < hide.length; i += 1) {
      this.hiddenVisibility[i] = hide[i].visible;
      hide[i].visible = false;
    }
    renderer.setRenderTarget(this.depthTarget);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    for (let i = 0; i < hide.length; i += 1) hide[i].visible = this.hiddenVisibility[i];
    this.mesh.visible = meshVisible;
    this.material.uniforms.uDepthValid.value = 1;
  }

  /** Keep the camera position in root-local space (root is scaled in y). */
  update(camera: THREE.Camera, root: THREE.Object3D, renderer: THREE.WebGLRenderer): void {
    this.inverse.copy(root.matrixWorld).invert();
    const u = this.material.uniforms;
    u.uCameraLocal.value.copy(camera.position).applyMatrix4(this.inverse);
    u.uRootInverse.value.copy(this.inverse);
    this.invProjection.copy(camera.projectionMatrix).invert();
    this.invView.copy(camera.matrixWorld);
    u.uInvProjection.value.copy(this.invProjection);
    u.uInvView.value.copy(this.invView);
    u.uResolution.value.set(renderer.domElement.width, renderer.domElement.height);
    u.uDepth.value = this.depthTarget.depthTexture;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.depthTarget.depthTexture?.dispose();
    this.depthTarget.dispose();
  }
}
