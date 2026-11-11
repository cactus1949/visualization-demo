import * as THREE from "three";
import { colormapTexture } from "./colormaps";
import { GLSL_DOMAIN, domainUniforms, type Domain } from "./fields";
import { GLSL_LOW_ALPHA, type ScalarBinding } from "./slices";
import type { CompositeSurface } from "./sections/composite";
import { type CutState, cutBounds } from "./cuts";

const MAX_SURFACES = 16;

const vertexShader = /* glsl */ `
uniform mat4 uRootInverse;
out vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
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
uniform float uMin;
uniform float uMax;
uniform float uFilterMin;
uniform float uFilterMax;
uniform float uFilterEnable;
uniform float uThreshold;
uniform float uOpacity;
uniform float uSteps;
uniform vec3 uCutLo;
uniform vec3 uCutHi;
uniform sampler3D uSliceField;
uniform sampler2D uSliceColormap;
uniform sampler3D uSectionField;
uniform sampler2D uSectionColormap;
uniform float uSurfEnabled[16];
uniform float uSurfKind[16];
uniform float uSurfBinding[16];
uniform vec4 uSurfP0[16];
uniform vec4 uSurfP1[16];
uniform float uSurfOpacity[16];
uniform float uSurfMin[16];
uniform float uSurfMax[16];
uniform float uSurfFilterMin[16];
uniform float uSurfFilterMax[16];
uniform float uSurfFilterEnable[16];
uniform float uSurfContours[16];
uniform float uSurfLowAlpha[16];
uniform float uSurfLowThreshold[16];
${GLSL_LOW_ALPHA}
uniform sampler2D uDepth;
uniform float uDepthValid;
uniform vec2 uResolution;
uniform mat4 uInvProjection;
uniform mat4 uInvView;
uniform mat4 uRootInverse;
in vec3 vWorld;
out vec4 outColor;

vec2 hitBox(vec3 o, vec3 d, vec3 lo, vec3 hi) {
  vec3 inv = 1.0 / d;
  vec3 a = (lo - o) * inv, b = (hi - o) * inv;
  vec3 mn = min(a, b), mx = max(a, b);
  return vec2(max(max(mn.x, mn.y), mn.z), min(min(mx.x, mx.y), mx.z));
}

bool insideAA(vec3 p, vec4 p0, vec4 p1) {
  return p.x >= p0.w - 1e-5 && p.x <= p1.x + 1e-5 && p.z >= p1.y - 1e-5 && p.z <= p1.z + 1e-5;
}

bool onSegment(vec3 p, vec4 p0, vec4 p1) {
  vec2 a = vec2(p0.w, p1.x);
  vec2 b = vec2(p1.y, p1.z);
  vec2 ab = b - a;
  float denom = max(dot(ab, ab), 1e-8);
  float t = dot(vec2(p.x, p.z) - a, ab) / denom;
  return t >= -1e-4 && t <= 1.0 + 1e-4;
}

float surfT(int i, vec3 o, vec3 d) {
  float q = 1e30;
  if (uSurfKind[i] < 0.5) {
    if (abs(d.y) > 1e-7) {
      q = (uSurfP0[i].x - o.y) / d.y;
      vec3 p = o + d * q;
      if (p.x < uSurfP0[i].y - 1e-5 || p.x > uSurfP0[i].z + 1e-5 || p.z < uSurfP0[i].w - 1e-5 || p.z > uSurfP1[i].x + 1e-5)
        q = 1e30;
    }
  } else {
    vec2 n = uSurfP0[i].xy;
    float den = n.x * d.x + n.y * d.z;
    if (abs(den) > 1e-7) {
      q = (uSurfP0[i].z - n.x * o.x - n.y * o.z) / den;
      vec3 p = o + d * q;
      bool yOk;
      if (uSurfBinding[i] > 1.5)
        yOk = p.y >= uCutLo.y - 1e-5 && p.y <= uCutHi.y + 1e-5;
      else
        yOk = p.y >= 0.0 && p.y <= uDomain.z;
      bool spanOk = uSurfP1[i].w > 0.5 ? onSegment(p, uSurfP0[i], uSurfP1[i]) : insideAA(p, uSurfP0[i], uSurfP1[i]);
      if (!yOk || !spanOk) q = 1e30;
    }
  }
  return q;
}

vec4 surfaceColor(int i, vec3 p) {
  float v;
  vec4 c;
  if (uSurfBinding[i] < 0.5) {
    v = texture(uSliceField, localToTex(p)).r;
    c = texture(uSliceColormap, vec2(clamp((v - uSurfMin[i]) / max(uSurfMax[i] - uSurfMin[i], 1e-9), 0.0, 1.0), 0.5));
  } else if (uSurfBinding[i] < 1.5) {
    v = texture(uSectionField, localToTex(p)).r;
    c = texture(uSectionColormap, vec2(clamp((v - uSurfMin[i]) / max(uSurfMax[i] - uSurfMin[i], 1e-9), 0.0, 1.0), 0.5));
  } else {
    v = texture(uField, localToTex(p)).r;
    c = texture(uColormap, vec2(clamp((v - uSurfMin[i]) / max(uSurfMax[i] - uSurfMin[i], 1e-9), 0.0, 1.0), 0.5));
  }
  if (uSurfFilterEnable[i] > 0.5 && (v < uSurfFilterMin[i] - 1e-6 || v > uSurfFilterMax[i] + 1e-6))
    return vec4(0.0);
  float n = clamp((v - uSurfMin[i]) / max(uSurfMax[i] - uSurfMin[i], 1e-9), 0.0, 1.0);
  if (uSurfContours[i] > 0.5) {
    float bands = n * uSurfContours[i];
    float dd = abs(fract(bands - 0.5) - 0.5) / max(fwidth(bands), 1e-5);
    c.rgb = mix(c.rgb, c.rgb * 0.35, (1.0 - smoothstep(0.0, 1.2, dd)) * 0.55);
  }
  c.a = uSurfOpacity[i] * lowAlphaFactor(n, uSurfLowAlpha[i], uSurfLowThreshold[i]);
  return c;
}

void main() {
  vec3 rayLocal = (uRootInverse * vec4(vWorld, 1.0)).xyz;
  vec3 dir = normalize(rayLocal - uCameraLocal);
  vec3 domainLo = vec3(-uDomain.x * 0.5, 0.0, -uDomain.y * 0.5);
  vec3 domainHi = vec3(uDomain.x * 0.5, uDomain.z, uDomain.y * 0.5);
  vec2 domainT = hitBox(uCameraLocal, dir, domainLo, domainHi);
  vec2 volT = hitBox(uCameraLocal, dir, uCutLo, uCutHi);
  float t0 = max(domainT.x, 0.0);
  float tEnd = domainT.y;
  if (uDepthValid > 0.5) {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float dep = texture(uDepth, uv).r;
    if (dep < 0.999999) {
      vec4 ndc = vec4(uv * 2.0 - 1.0, dep * 2.0 - 1.0, 1.0);
      vec4 vp = uInvProjection * ndc;
      vp /= max(vp.w, 1e-8);
      vec3 dl = (uRootInverse * (uInvView * vp)).xyz;
      tEnd = min(tEnd, dot(dl - uCameraLocal, dir) - 1e-4);
    }
  }
  if (t0 >= tEnd) discard;

  float ts[16];
  bool used[16];
  for (int i = 0; i < 16; i++) {
    ts[i] = 1e30;
    used[i] = false;
    if (uSurfEnabled[i] > 0.5) {
      ts[i] = surfT(i, uCameraLocal, dir);
      if (ts[i] < t0 - 1e-5 || ts[i] > tEnd + 1e-5) ts[i] = 1e30;
    }
  }

  float dt = (tEnd - t0) / uSteps;
  float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec4 acc = vec4(0.0);
  bool contributed = false;

  for (float k = 0.0; k < 256.0; k++) {
    if (k >= uSteps || acc.a > 0.97) break;
    float sampleT = t0 + (k + jit) * dt;
    for (int pass = 0; pass < 16; pass++) {
      int best = -1;
      float bt = 1e30;
      for (int i = 0; i < 16; i++) {
        if (!used[i] && ts[i] < bt) { bt = ts[i]; best = i; }
      }
      if (best < 0 || bt > sampleT) break;
      vec4 sc = surfaceColor(best, uCameraLocal + dir * bt);
      used[best] = true;
      if (sc.a > 0.0) {
        acc.rgb += (1.0 - acc.a) * sc.a * sc.rgb;
        acc.a += (1.0 - acc.a) * sc.a;
        contributed = true;
        if (sc.a >= 0.999) { tEnd = bt; break; }
      }
    }
    if (acc.a > 0.97) break;
    if (sampleT < volT.x || sampleT > volT.y) continue;
    vec3 p = uCameraLocal + dir * sampleT;
    if (p.x < uCutLo.x || p.x > uCutHi.x || p.y < uCutLo.y || p.y > uCutHi.y || p.z < uCutLo.z || p.z > uCutHi.z)
      continue;
    float v = texture(uField, localToTex(p)).r;
    if (uFilterEnable > 0.5 && (v < uFilterMin - 1e-6 || v > uFilterMax + 1e-6)) continue;
    float n = clamp((v - uMin) / max(uMax - uMin, 1e-9), 0.0, 1.0);
    if (n < uThreshold) continue;
    vec3 c = texture(uColormap, vec2(n, 0.5)).rgb;
    float a = uOpacity * smoothstep(uThreshold, 1.0, n) * dt * 6.0;
    acc.rgb += (1.0 - acc.a) * a * c;
    acc.a += (1.0 - acc.a) * a;
  }

  for (int pass = 0; pass < 16; pass++) {
    if (acc.a > 0.97) break;
    int best = -1;
    float bt = 1e30;
    for (int i = 0; i < 16; i++) {
      if (!used[i] && ts[i] < bt) { bt = ts[i]; best = i; }
    }
    if (best < 0 || bt > tEnd) break;
    vec4 sc = surfaceColor(best, uCameraLocal + dir * bt);
    used[best] = true;
    if (sc.a > 0.0) {
      acc.rgb += (1.0 - acc.a) * sc.a * sc.rgb;
      acc.a += (1.0 - acc.a) * sc.a;
      contributed = true;
      if (sc.a >= 0.999) break;
    }
  }

  if (acc.a < 0.003 && !contributed) discard;
  outColor = vec4(acc.rgb / max(acc.a, 1e-8), acc.a);
}
`;

export class VolumeLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly depthTarget: THREE.WebGLRenderTarget;
  private readonly inverse = new THREE.Matrix4();
  private readonly invProjection = new THREE.Matrix4();
  private readonly invView = new THREE.Matrix4();
  private hiddenVisibility: boolean[] = [];
  private depthWidth = 1;
  private depthHeight = 1;
  private domain: Domain;

  constructor(domain: Domain) {
    this.domain = domain;
    const uniforms: Record<string, THREE.IUniform> = {
      ...domainUniforms(domain),
      uField: { value: null },
      uColormap: { value: colormapTexture("magma") },
      uCameraLocal: { value: new THREE.Vector3() },
      uMin: { value: 0 },
      uMax: { value: 1 },
      uFilterMin: { value: 0 },
      uFilterMax: { value: 1 },
      uFilterEnable: { value: 0 },
      uThreshold: { value: 0.15 },
      uOpacity: { value: 0.6 },
      uSteps: { value: 128 },
      uCutLo: { value: new THREE.Vector3(-domain.sx / 2, 0, -domain.sz / 2) },
      uCutHi: { value: new THREE.Vector3(domain.sx / 2, domain.top, domain.sz / 2) },
      uSliceField: { value: null },
      uSliceColormap: { value: colormapTexture("viridis") },
      uSectionField: { value: null },
      uSectionColormap: { value: colormapTexture("viridis") },
      uDepth: { value: null },
      uDepthValid: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uInvProjection: { value: new THREE.Matrix4() },
      uInvView: { value: new THREE.Matrix4() },
      uRootInverse: { value: new THREE.Matrix4() },
    };
    for (const n of [
      "Enabled",
      "Kind",
      "Binding",
      "Opacity",
      "Min",
      "Max",
      "FilterMin",
      "FilterMax",
      "FilterEnable",
      "Contours",
      "LowAlpha",
      "LowThreshold",
    ]) {
      uniforms[`uSurf${n}`] = { value: new Array(MAX_SURFACES).fill(0) };
    }
    uniforms.uSurfP0 = { value: Array.from({ length: MAX_SURFACES }, () => new THREE.Vector4()) };
    uniforms.uSurfP1 = { value: Array.from({ length: MAX_SURFACES }, () => new THREE.Vector4()) };

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    const box = new THREE.BoxGeometry(domain.sx, domain.top, domain.sz).translate(0, domain.top / 2, 0);
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

  /** Last colour mapping handed to the raymarcher (for debug comparisons). */
  bound: { colormap: string; min: number; max: number } | null = null;

  bind(field: ScalarBinding, colormap: string, min: number, max: number): void {
    this.bound = { colormap, min, max };
    const u = this.material.uniforms;
    u.uField.value = field.texture;
    u.uColormap.value = colormapTexture(colormap);
    u.uMin.value = min;
    u.uMax.value = max;
  }

  setFilter(min: number, max: number, enabled: boolean): void {
    const u = this.material.uniforms;
    u.uFilterMin.value = Math.min(min, max);
    u.uFilterMax.value = Math.max(min, max);
    u.uFilterEnable.value = enabled ? 1 : 0;
  }

  /** Cuts shrink the raymarched volume only; the mesh stays the full domain so sections still composite outside the cut. */
  setCuts(cuts: CutState): void {
    const b = cutBounds(this.domain, cuts);
    this.material.uniforms.uCutLo.value.copy(b.lo);
    this.material.uniforms.uCutHi.value.copy(b.hi);
  }

  setSurfaces(surfaces: CompositeSurface[]): void {
    const u = this.material.uniforms;
    for (let i = 0; i < MAX_SURFACES; i++) u.uSurfEnabled.value[i] = 0;
    for (let i = 0; i < Math.min(MAX_SURFACES, surfaces.length); i++) {
      const s = surfaces[i];
      u.uSurfEnabled.value[i] = s.field ? 1 : 0;
      u.uSurfKind.value[i] = s.kind === "horizontal" ? 0 : 1;
      u.uSurfBinding.value[i] = s.binding === "slice" ? 0 : s.binding === "section" ? 1 : 2;
      u.uSurfOpacity.value[i] = s.opacity;
      u.uSurfMin.value[i] = s.min;
      u.uSurfMax.value[i] = s.max;
      u.uSurfFilterMin.value[i] = s.filterMin;
      u.uSurfFilterMax.value[i] = s.filterMax;
      u.uSurfFilterEnable.value[i] = s.filterEnable ? 1 : 0;
      u.uSurfContours.value[i] = s.contours;
      u.uSurfLowAlpha.value[i] = s.lowAlpha ? 1 : 0;
      u.uSurfLowThreshold.value[i] = s.lowThreshold ?? 0.15;
      if (s.field) {
        if (s.binding === "slice") {
          u.uSliceField.value = s.field.texture;
          u.uSliceColormap.value = colormapTexture(s.colormap);
        } else if (s.binding === "section") {
          u.uSectionField.value = s.field.texture;
          u.uSectionColormap.value = colormapTexture(s.colormap);
        }
      }
      const p0 = u.uSurfP0.value[i] as THREE.Vector4;
      const p1 = u.uSurfP1.value[i] as THREE.Vector4;
      if (s.kind === "horizontal") {
        p0.set(s.height ?? 0, s.clipX0 ?? -this.domain.sx / 2, s.clipX1 ?? this.domain.sx / 2, s.clipZ0 ?? -this.domain.sz / 2);
        p1.set(s.clipZ1 ?? this.domain.sz / 2, 0, 0, 0);
      } else if (s.ax !== undefined && s.az !== undefined && s.bx !== undefined && s.bz !== undefined) {
        p0.set(s.normalX ?? 1, s.normalZ ?? 0, s.offset ?? 0, s.ax);
        p1.set(s.az, s.bx, s.bz, 1);
      } else {
        p0.set(s.normalX ?? 1, s.normalZ ?? 0, s.offset ?? 0, s.clipX0 ?? -this.domain.sx / 2);
        p1.set(s.clipX1 ?? this.domain.sx / 2, s.clipZ0 ?? -this.domain.sz / 2, s.clipZ1 ?? this.domain.sz / 2, 0);
      }
    }
  }

  resize(renderer: THREE.WebGLRenderer): void {
    const w = Math.max(1, renderer.domElement.width);
    const h = Math.max(1, renderer.domElement.height);
    if (w !== this.depthWidth || h !== this.depthHeight) {
      this.depthTarget.setSize(w, h);
      this.depthWidth = w;
      this.depthHeight = h;
    }
    this.material.uniforms.uResolution.value.set(w, h);
  }

  captureDepth(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, hide: THREE.Object3D[]): void {
    this.resize(renderer);
    const vis = this.mesh.visible;
    this.mesh.visible = false;
    for (let i = 0; i < hide.length; i++) {
      this.hiddenVisibility[i] = hide[i].visible;
      hide[i].visible = false;
    }
    renderer.setRenderTarget(this.depthTarget);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    for (let i = 0; i < hide.length; i++) hide[i].visible = this.hiddenVisibility[i];
    this.mesh.visible = vis;
    this.material.uniforms.uDepthValid.value = 1;
  }

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
