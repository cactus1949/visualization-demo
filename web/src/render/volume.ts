import * as THREE from "three";
import { colormapTexture } from "./colormaps";
import { GLSL_DOMAIN, domainUniforms, type Domain } from "./fields";
import type { ScalarBinding } from "./slices";

export interface SlicePlaneConfig {
  enabled: boolean;
  field: ScalarBinding | null;
  min: number;
  max: number;
  opacity: number;
  colormap: string;
  filterMin: number;
  filterMax: number;
  filterEnable: boolean;
  contours: number;
  height?: number;
  normal?: THREE.Vector2;
  offset?: number;
}

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
uniform float uHEnabled;
uniform float uHHeight;
uniform sampler3D uHField;
uniform float uHScale;
uniform float uHOffset;
uniform float uHLog;
uniform sampler2D uHColormap;
uniform float uHMin;
uniform float uHMax;
uniform float uHOpacity;
uniform float uHFilterMin;
uniform float uHFilterMax;
uniform float uHFilterEnable;
uniform float uHContours;
uniform float uVEnabled;
uniform vec2 uVNormal;
uniform float uVOffset;
uniform sampler3D uVField;
uniform float uVScale;
uniform float uVFieldOffset;
uniform float uVLog;
uniform sampler2D uVColormap;
uniform float uVMin;
uniform float uVMax;
uniform float uVOpacity;
uniform float uVFilterMin;
uniform float uVFilterMax;
uniform float uVFilterEnable;
uniform float uVContours;
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
  float tH = 1e30;
  float tV = 1e30;
  if (uHEnabled > 0.5 && abs(dir.y) > 1e-7) {
    float q = (uHHeight - uCameraLocal.y) / dir.y;
    vec3 hp = uCameraLocal + dir * q;
    if (q >= t.x - 1e-5 && q <= tEnd + 1e-5 && hp.x >= lo.x - 1e-5 && hp.x <= hi.x + 1e-5 && hp.z >= lo.z - 1e-5 && hp.z <= hi.z + 1e-5) tH = q;
  }
  float vden = uVNormal.x * dir.x + uVNormal.y * dir.z;
  if (uVEnabled > 0.5 && abs(vden) > 1e-7) {
    float q = (uVOffset - uVNormal.x * uCameraLocal.x - uVNormal.y * uCameraLocal.z) / vden;
    vec3 vp = uCameraLocal + dir * q;
    if (q >= t.x - 1e-5 && q <= tEnd + 1e-5 && vp.x >= lo.x - 1e-5 && vp.x <= hi.x + 1e-5 && vp.z >= lo.z - 1e-5 && vp.z <= hi.z + 1e-5 && vp.y >= -1e-5 && vp.y <= hi.y + 1e-5) tV = q;
  }
  bool hApplied = false;
  bool vApplied = false;
  bool sliceContributed = false;
  float dt = (tEnd - t.x) / uSteps;
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec4 acc = vec4(0.0);
  for (float i = 0.0; i < 256.0; i += 1.0) {
    if (i >= uSteps || acc.a > 0.97) break;
    float tSample = t.x + (i + jitter) * dt;
    if (!hApplied && tH <= tSample && (tH <= tV || vApplied)) {
      vec3 p = uCameraLocal + dir * tH;
      float raw = texture(uHField, localToTex(p)).r * 255.0 * uHScale + uHOffset;
      float value = uHLog > 0.5 ? pow(10.0, raw) : raw;
      if (uHFilterEnable < 0.5 || (value >= uHFilterMin - 1e-6 && value <= uHFilterMax + 1e-6)) {
        float n = clamp((value - uHMin) / max(uHMax - uHMin, 1e-9), 0.0, 1.0);
        vec3 c = texture(uHColormap, vec2(n, 0.5)).rgb;
        if (uHContours > 0.5) { float bands = n * uHContours; float d = abs(fract(bands - 0.5) - 0.5) / max(fwidth(bands), 1e-5); c = mix(c, c * 0.35, (1.0 - smoothstep(0.0, 1.2, d)) * 0.55); }
        float a = uHOpacity; acc.rgb += (1.0 - acc.a) * a * c; acc.a += (1.0 - acc.a) * a; sliceContributed = sliceContributed || a > 0.0;
        if (uHOpacity >= 0.999) { tEnd = tH; break; }
      }
      hApplied = true;
    }
    if (!vApplied && tV <= tSample && (tV <= tH || hApplied)) {
      vec3 p = uCameraLocal + dir * tV;
      float raw = texture(uVField, localToTex(p)).r * 255.0 * uVScale + uVFieldOffset;
      float value = uVLog > 0.5 ? pow(10.0, raw) : raw;
      if (uVFilterEnable < 0.5 || (value >= uVFilterMin - 1e-6 && value <= uVFilterMax + 1e-6)) {
        float n = clamp((value - uVMin) / max(uVMax - uVMin, 1e-9), 0.0, 1.0);
        vec3 c = texture(uVColormap, vec2(n, 0.5)).rgb;
        if (uVContours > 0.5) { float bands = n * uVContours; float d = abs(fract(bands - 0.5) - 0.5) / max(fwidth(bands), 1e-5); c = mix(c, c * 0.35, (1.0 - smoothstep(0.0, 1.2, d)) * 0.55); }
        float a = uVOpacity; acc.rgb += (1.0 - acc.a) * a * c; acc.a += (1.0 - acc.a) * a; sliceContributed = sliceContributed || a > 0.0;
        if (uVOpacity >= 0.999) { tEnd = tV; break; }
      }
      vApplied = true;
    }
    vec3 p = uCameraLocal + dir * tSample;
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
  // Flush any slice that sits after the last stepped sample, closer plane first.
  // If the volume already accumulated to nearly opaque, a farther slice stays hidden.
  for (int k = 0; k < 2; k += 1) {
    if (acc.a > 0.97) break;
    bool doH = !hApplied && tH <= tEnd && (tH <= tV || vApplied);
    bool doV = !vApplied && tV <= tEnd && (tV <= tH || hApplied);
    if (doH) {
      vec3 p = uCameraLocal + dir * tH;
      float raw = texture(uHField, localToTex(p)).r * 255.0 * uHScale + uHOffset;
      float value = uHLog > 0.5 ? pow(10.0, raw) : raw;
      if (uHFilterEnable < 0.5 || (value >= uHFilterMin - 1e-6 && value <= uHFilterMax + 1e-6)) {
        float n = clamp((value - uHMin) / max(uHMax - uHMin, 1e-9), 0.0, 1.0);
        vec3 c = texture(uHColormap, vec2(n, 0.5)).rgb;
        float a = uHOpacity;
        acc.rgb += (1.0 - acc.a) * a * c;
        acc.a += (1.0 - acc.a) * a;
        sliceContributed = sliceContributed || a > 0.0;
        if (uHOpacity >= 0.999) break;
      }
      hApplied = true;
    } else if (doV) {
      vec3 p = uCameraLocal + dir * tV;
      float raw = texture(uVField, localToTex(p)).r * 255.0 * uVScale + uVFieldOffset;
      float value = uVLog > 0.5 ? pow(10.0, raw) : raw;
      if (uVFilterEnable < 0.5 || (value >= uVFilterMin - 1e-6 && value <= uVFilterMax + 1e-6)) {
        float n = clamp((value - uVMin) / max(uVMax - uVMin, 1e-9), 0.0, 1.0);
        vec3 c = texture(uVColormap, vec2(n, 0.5)).rgb;
        float a = uVOpacity;
        acc.rgb += (1.0 - acc.a) * a * c;
        acc.a += (1.0 - acc.a) * a;
        sliceContributed = sliceContributed || a > 0.0;
        if (uVOpacity >= 0.999) break;
      }
      vApplied = true;
    } else break;
  }
  if (acc.a < 0.003 && !sliceContributed) discard;
  outColor = vec4(acc.rgb / max(acc.a, 1e-8), acc.a);
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
        uHEnabled: { value: 0 },
        uHHeight: { value: 0 },
        uHField: { value: null },
        uHScale: { value: 1 },
        uHOffset: { value: 0 },
        uHLog: { value: 0 },
        uHColormap: { value: colormapTexture("viridis") },
        uHMin: { value: 0 },
        uHMax: { value: 1 },
        uHOpacity: { value: 0 },
        uHFilterMin: { value: 0 },
        uHFilterMax: { value: 1 },
        uHFilterEnable: { value: 0 },
        uHContours: { value: 0 },
        uVEnabled: { value: 0 },
        uVNormal: { value: new THREE.Vector2(1, 0) },
        uVOffset: { value: 0 },
        uVField: { value: null },
        uVScale: { value: 1 },
        uVFieldOffset: { value: 0 },
        uVLog: { value: 0 },
        uVColormap: { value: colormapTexture("viridis") },
        uVMin: { value: 0 },
        uVMax: { value: 1 },
        uVOpacity: { value: 0 },
        uVFilterMin: { value: 0 },
        uVFilterMax: { value: 1 },
        uVFilterEnable: { value: 0 },
        uVContours: { value: 0 },
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

  setHorizontalSlice(config: SlicePlaneConfig | null): void {
    this.setPlane("H", config);
  }
  setVerticalSlice(config: SlicePlaneConfig | null): void {
    this.setPlane("V", config);
  }
  private setPlane(prefix: "H" | "V", config: SlicePlaneConfig | null): void {
    const u = this.material.uniforms;
    u[`u${prefix}Enabled`].value = config?.enabled && config.field ? 1 : 0;
    if (!config?.field) return;
    u[`u${prefix}Field`].value = config.field.texture;
    u[`u${prefix}Scale`].value = config.field.scale;
    u[prefix === "H" ? "uHOffset" : "uVFieldOffset"].value = config.field.offset;
    u[`u${prefix}Log`].value = config.field.log10 ? 1 : 0;
    u[`u${prefix}Colormap`].value = colormapTexture(config.colormap);
    u[`u${prefix}Min`].value = config.min;
    u[`u${prefix}Max`].value = config.max;
    u[`u${prefix}Opacity`].value = config.opacity;
    u[`u${prefix}FilterMin`].value = config.filterMin;
    u[`u${prefix}FilterMax`].value = config.filterMax;
    u[`u${prefix}FilterEnable`].value = config.filterEnable ? 1 : 0;
    u[`u${prefix}Contours`].value = config.contours;
    if (prefix === "H") u.uHHeight.value = config.height ?? 0;
    else {
      u.uVNormal.value.copy(config.normal ?? new THREE.Vector2(1, 0));
      u.uVOffset.value = config.offset ?? 0;
    }
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
