import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { colormapTexture } from "./colormaps";
import type { Domain } from "./fields";

/**
 * GPGPU wind particles with persistent trails (WebGL2).
 *
 * State  : two RGBA32F render targets (ping-pong), one texel per particle.
 *          xyz = position in grid space (gx, gy in 0..1, height in km), w = age in steps.
 * Advect : a full-screen fragment pass samples the packed RGBA8 wind 3D texture with
 *          hardware trilinear filtering and integrates with RK2 (midpoint).
 * History: an RGBA32F WebGLArrayRenderTarget with N layers is a per-particle ring buffer;
 *          every step the new state is copied into layer `head`.
 * Trails : one instanced draw. Each instance is a ribbon of N nodes; the vertex shader
 *          fetches node k from layer (head − k) mod N, projects it and extrudes it in screen
 *          space to the requested pixel width. Trails are real 3D geometry, so they stay
 *          correct while the camera moves (no screen-space fading).
 * No CPU work per particle, no readbacks in the frame loop.
 */

export type ColorMode = "speed" | "w" | "height" | "single";

export interface ParticleParams {
  count: number;
  trailLength: number;
  speed: number;
  lineWidth: number;
  lifetime: number; // seconds at 60 steps/s
  opacity: number;
  colorMode: ColorMode;
  colormap: string;
  color: string;
  heightMin: number; // m
  heightMax: number; // m
  wExaggeration: number;
  timeScale: number;
  additive: boolean;
  paused: boolean;
  taper: boolean;
}

export const DEFAULT_PARTICLES: ParticleParams = {
  count: 32000,
  trailLength: 48,
  speed: 1,
  lineWidth: 1.3,
  lifetime: 8,
  opacity: 0.55,
  colorMode: "speed",
  colormap: "glacier",
  color: "#8fe9ff",
  heightMin: 20,
  heightMax: 300,
  wExaggeration: 1,
  timeScale: 150,
  additive: false,
  paused: false,
  taper: true,
};

export interface WindBinding {
  texture: THREE.Data3DTexture;
  /** per channel: m/s = byte * scale + offset */
  scale: THREE.Vector3;
  offset: THREE.Vector3;
  /** alpha channel = speed byte / 255 * maxSpeed */
  maxSpeed: number;
  speedRange: [number, number];
  wRange: number;
}

const GLSL_HASH = /* glsl */ `
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float hash1(uint v) { return float(pcg(v)) / 4294967295.0; }
`;

const GLSL_WIND = /* glsl */ `
uniform highp sampler3D uWind;
uniform vec3 uWindScale;
uniform vec3 uWindOffset;
uniform vec3 uDomain; // sx, sz, top (km)
uniform vec3 uGridN;
vec3 gridToTex(vec3 g) {
  return vec3((g.xy * (uGridN.xy - 1.0) + 0.5) / uGridN.xy, g.z / uDomain.z);
}
vec4 windRaw(vec3 g) { return textureLod(uWind, gridToTex(g), 0.0); }
vec3 windMs(vec4 raw) { return raw.rgb * 255.0 * uWindScale + uWindOffset; }
`;

const simFragment = /* glsl */ `
precision highp float;
precision highp int;
${GLSL_HASH}
${GLSL_WIND}
uniform sampler2D uState;
uniform float uDt;          // simulated seconds for this step
uniform float uWExag;
uniform float uLifeSteps;
uniform uint uSeed;
uniform vec2 uHeight;       // km
uniform float uReset;
uniform int uSize;
out vec4 outState;

// grid-space velocity: gx, gy per second and km per second for height
vec3 velocity(vec3 g) {
  vec3 w = windMs(windRaw(g));
  return vec3(w.x / (uDomain.x * 1000.0), w.y / (uDomain.y * 1000.0), w.z * uWExag / 1000.0);
}

vec4 spawn(uint id, bool initial, float life) {
  uint s = id * 9781u + uSeed * 6271u;
  float h = mix(uHeight.x, uHeight.y, hash1(s + 3u));
  // stagger ages on first spawn so particles do not respawn in lock-step
  float age = initial ? floor(hash1(s + 4u) * life) : 0.0;
  return vec4(hash1(s + 1u), hash1(s + 2u), h, age);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uint id = uint(p.y * uSize + p.x);
  vec4 s = texelFetch(uState, p, 0);
  float life = uLifeSteps * (0.5 + hash1(id * 7919u + 17u));
  if (uReset > 0.5) { outState = spawn(id, true, life); return; }
  if (s.w > life) { outState = spawn(id, false, life); return; }
  // RK2 midpoint
  vec3 k1 = velocity(s.xyz);
  vec3 k2 = velocity(s.xyz + 0.5 * uDt * k1);
  vec3 next = s.xyz + uDt * k2;
  bool outside = next.x < 0.0 || next.x > 1.0 || next.y < 0.0 || next.y > 1.0 ||
                 next.z < uHeight.x - 0.02 || next.z > uHeight.y + 0.02 ||
                 next.z < 0.003 || next.z > uDomain.z;
  outState = outside ? spawn(id, false, life) : vec4(next, s.w + 1.0);
}
`;

const copyFragment = /* glsl */ `
precision highp float;
uniform sampler2D uState;
out vec4 outColor;
void main() { outColor = texelFetch(uState, ivec2(gl_FragCoord.xy), 0); }
`;

const fillFragment = copyFragment;

const quadVertex = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const trailVertex = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;
${GLSL_WIND}
uniform sampler2DArray uHistory;
uniform sampler2D uState;
uniform sampler2D uColormap;
uniform int uHead;
uniform int uLayers;
uniform int uTrail;
uniform vec2 uResolution;
uniform float uWidth;
uniform float uTaper;
uniform int uColorMode;
uniform vec3 uColorRange; // speed: (maxSpeed, lo, hi) m/s; w: (range, 0, 0)
in float aNode;
in float aSide;
in vec2 aTexel;
out float vAlpha;
out float vSide;
out vec3 vColor;

vec3 node(ivec2 texel, int k) {
  int layer = (uHead - k + uLayers) % uLayers;
  return texelFetch(uHistory, ivec3(texel, layer), 0).xyz;
}
vec3 toLocal(vec3 g) {
  return vec3((g.x - 0.5) * uDomain.x, g.z, (0.5 - g.y) * uDomain.y);
}
vec4 toClip(vec3 g) {
  return projectionMatrix * modelViewMatrix * vec4(toLocal(g), 1.0);
}

void main() {
  ivec2 texel = ivec2(aTexel);
  float age = texelFetch(uState, texel, 0).w;
  int maxK = min(uTrail - 1, int(age));
  int k = int(aNode);
  int kc = min(k, maxK);
  vec3 g = node(texel, kc);
  vec3 gPrev = node(texel, max(kc - 1, 0));
  vec3 gNext = node(texel, min(kc + 1, maxK));
  vec4 clip = toClip(g);
  vec4 clipPrev = toClip(gPrev);
  vec4 clipNext = toClip(gNext);
  vec2 a = clipPrev.xy / max(clipPrev.w, 1e-4) * uResolution;
  vec2 b = clipNext.xy / max(clipNext.w, 1e-4) * uResolution;
  vec2 dir = b - a;
  float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float f = maxK > 0 ? float(kc) / float(maxK) : 1.0;
  float width = len > 1e-3 ? uWidth * mix(1.0, 0.25, f * uTaper) : 0.0;
  // offset in NDC: pixels * 2 / resolution, times w to undo the perspective divide
  clip.xy += normal * aSide * width / uResolution * clip.w;
  gl_Position = clip;
  vSide = aSide;
  bool visible = k <= maxK && maxK > 0 && len > 1e-3 && clip.w > 0.0;
  vAlpha = visible ? pow(1.0 - float(kc) / float(uTrail), 1.2) : 0.0;

  vec4 raw = windRaw(g);
  float t;
  if (uColorMode == 0) {
    float speed = raw.a * uColorRange.x;
    t = (speed - uColorRange.y) / max(uColorRange.z - uColorRange.y, 1e-3);
  } else if (uColorMode == 1) {
    t = 0.5 + 0.5 * windMs(raw).z / uColorRange.x;
  } else {
    t = g.z / uDomain.z;
  }
  vColor = textureLod(uColormap, vec2(clamp(t, 0.0, 1.0), 0.5), 0.0).rgb;
}
`;

const trailFragment = /* glsl */ `
precision highp float;
uniform float uOpacity;
uniform int uColorMode;
uniform vec3 uSingle;
in float vAlpha;
in float vSide;
in vec3 vColor;
out vec4 outColor;
void main() {
  // soft edge across the ribbon for cheap anti-aliasing
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
  float alpha = vAlpha * edge * uOpacity;
  if (alpha < 0.004) discard;
  vec3 color = uColorMode == 3 ? uSingle : vColor;
  outColor = vec4(color, alpha);
}
`;

function floatTarget(size: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(size, size, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
}

function trailGeometry(nodes: number, count: number, size: number): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  const node = new Float32Array(nodes * 2);
  const side = new Float32Array(nodes * 2);
  const index: number[] = [];
  for (let k = 0; k < nodes; k += 1) {
    node[k * 2] = k;
    node[k * 2 + 1] = k;
    side[k * 2] = -1;
    side[k * 2 + 1] = 1;
    if (k < nodes - 1) {
      const a = k * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  // three needs a position attribute to compute the draw count; it is unused by the shader.
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nodes * 6), 3));
  geometry.setAttribute("aNode", new THREE.BufferAttribute(node, 1));
  geometry.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
  geometry.setIndex(index);
  const texel = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    texel[i * 2] = i % size;
    texel[i * 2 + 1] = Math.floor(i / size);
  }
  geometry.setAttribute("aTexel", new THREE.InstancedBufferAttribute(texel, 2));
  geometry.instanceCount = count;
  return geometry;
}

export class WindParticles {
  readonly object: THREE.Mesh;
  readonly label = "粒子: WebGL2 GPGPU（浮点纹理 ping-pong + 历史环形缓冲）";
  params: ParticleParams;
  count = 0;
  private size = 0;
  private layers = 0;
  private head = 0;
  private seed = 1;
  private needsReset = true;
  private state: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private history: THREE.WebGLArrayRenderTarget | null = null;
  private readonly simQuad: FullScreenQuad;
  private readonly copyQuad: FullScreenQuad;
  private readonly simMaterial: THREE.ShaderMaterial;
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly trailMaterial: THREE.ShaderMaterial;
  private readonly resolution = new THREE.Vector2(1, 1);

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly domain: Domain,
    private readonly wind: WindBinding,
    params: Partial<ParticleParams> = {},
  ) {
    this.params = { ...DEFAULT_PARTICLES, ...params };
    const windUniforms = () => ({
      uWind: { value: wind.texture },
      uWindScale: { value: wind.scale },
      uWindOffset: { value: wind.offset },
      uDomain: { value: new THREE.Vector3(domain.sx, domain.sz, domain.top) },
      uGridN: { value: new THREE.Vector3(domain.nx, domain.ny, domain.nz) },
    });
    this.simMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: quadVertex,
      fragmentShader: simFragment,
      uniforms: {
        ...windUniforms(),
        uState: { value: null },
        uDt: { value: 0 },
        uWExag: { value: 1 },
        uLifeSteps: { value: 360 },
        uSeed: { value: 1 },
        uHeight: { value: new THREE.Vector2(0.02, 0.6) },
        uReset: { value: 1 },
        uSize: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.copyMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: quadVertex,
      fragmentShader: fillFragment,
      uniforms: { uState: { value: null } },
      depthTest: false,
      depthWrite: false,
    });
    this.simQuad = new FullScreenQuad(this.simMaterial);
    this.copyQuad = new FullScreenQuad(this.copyMaterial);
    this.trailMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: trailVertex,
      fragmentShader: trailFragment,
      uniforms: {
        ...windUniforms(),
        uHistory: { value: null },
        uState: { value: null },
        uColormap: { value: colormapTexture("turbo") },
        uHead: { value: 0 },
        uLayers: { value: 1 },
        uTrail: { value: 2 },
        uResolution: { value: this.resolution },
        uWidth: { value: 1.5 },
        uTaper: { value: 1 },
        uColorMode: { value: 0 },
        uColorRange: { value: new THREE.Vector3(1, 0, 1) },
        uOpacity: { value: 0.85 },
        uSingle: { value: new THREE.Color() },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide, // ribbon winding depends on the screen-space direction
    });
    this.object = new THREE.Mesh(new THREE.InstancedBufferGeometry(), this.trailMaterial);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.name = "wind-particles";
    this.allocate();
    this.apply();
  }

  /** (Re)allocate GPU state when the particle count changes. */
  private allocate(): void {
    const count = Math.max(1024, Math.min(262144, Math.round(this.params.count)));
    const size = Math.ceil(Math.sqrt(count));
    // ring buffer depth: 64 steps up to 65k particles, 32 beyond (VRAM: size² × N × 16 B)
    const layers = count > 70000 ? 32 : 64;
    if (size === this.size && layers === this.layers && count === this.count) return;
    this.disposeTargets();
    this.size = size;
    this.layers = layers;
    this.count = count;
    this.state = [floatTarget(size), floatTarget(size)];
    this.history = new THREE.WebGLArrayRenderTarget(size, size, layers, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    this.object.geometry.dispose();
    this.object.geometry = trailGeometry(layers, count, size);
    this.needsReset = true;
  }

  /** Apply parameter changes; cheap (uniforms only) except when the count changes. */
  setParams(params: Partial<ParticleParams>): void {
    const before = this.params;
    this.params = { ...this.params, ...params };
    if (this.params.count !== before.count) this.allocate();
    if (this.params.heightMin !== before.heightMin || this.params.heightMax !== before.heightMax) {
      this.needsReset = true;
    }
    this.apply();
  }

  private apply(): void {
    const p = this.params;
    const sim = this.simMaterial.uniforms;
    sim.uWExag.value = p.wExaggeration;
    sim.uLifeSteps.value = Math.max(10, p.lifetime * 60);
    const lo = Math.min(p.heightMin, p.heightMax - 25) / 1000;
    const hi = Math.max(p.heightMax, p.heightMin + 25) / 1000;
    sim.uHeight.value.set(Math.max(0.005, lo), Math.min(this.domain.top - 0.005, hi));
    sim.uSize.value = this.size;
    const trail = this.trailMaterial.uniforms;
    const trailLength = Math.max(2, Math.min(this.layers, Math.round(p.trailLength)));
    trail.uTrail.value = trailLength;
    trail.uLayers.value = this.layers;
    trail.uWidth.value = p.lineWidth;
    trail.uTaper.value = p.taper ? 1 : 0;
    trail.uOpacity.value = p.opacity;
    trail.uColormap.value = colormapTexture(p.colormap);
    const modes: Record<ColorMode, number> = { speed: 0, w: 1, height: 2, single: 3 };
    trail.uColorMode.value = modes[p.colorMode];
    if (p.colorMode === "speed") {
      const [lo, hi] = this.wind.speedRange;
      trail.uColorRange.value.set(this.wind.maxSpeed, lo, hi);
    } else if (p.colorMode === "w") {
      trail.uColorRange.value.set(this.wind.wRange, 0, 0);
    }
    (trail.uSingle.value as THREE.Color).set(p.color);
    this.trailMaterial.blending = p.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    // only draw the segments that are inside the requested trail length
    this.object.geometry.setDrawRange(0, (trailLength - 1) * 6);
  }

  /** Advance the simulation by one step (call once per frame before rendering). */
  step(frameSeconds: number): void {
    if (!this.state || !this.history) return;
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    const sim = this.simMaterial.uniforms;
    const reset = this.needsReset;
    if (!this.params.paused || reset) {
      sim.uState.value = this.state[0].texture;
      sim.uReset.value = reset ? 1 : 0;
      sim.uSeed.value = this.seed++ >>> 0;
      sim.uDt.value = reset
        ? 0
        : Math.min(frameSeconds, 1 / 20) * this.params.timeScale * this.params.speed;
      renderer.setRenderTarget(this.state[1]);
      this.simQuad.render(renderer);
      this.state.reverse();
      this.copyMaterial.uniforms.uState.value = this.state[0].texture;
      if (reset) {
        // fill every history layer with the spawn position: trails start collapsed
        for (let layer = 0; layer < this.layers; layer += 1) {
          renderer.setRenderTarget(this.history, layer);
          this.copyQuad.render(renderer);
        }
        this.needsReset = false;
      } else {
        this.head = (this.head + 1) % this.layers;
        renderer.setRenderTarget(this.history, this.head);
        this.copyQuad.render(renderer);
      }
    }
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
    const trail = this.trailMaterial.uniforms;
    trail.uHistory.value = this.history.texture;
    trail.uState.value = this.state[0].texture;
    trail.uHead.value = this.head;
    renderer.getDrawingBufferSize(this.resolution);
  }

  /** Debug readback of particle 0 (grid space). Never call this in the frame loop. */
  sample(): number[] {
    if (!this.state) return [];
    const out = new Float32Array(4);
    this.renderer.readRenderTargetPixels(this.state[0], 0, 0, 1, 1, out);
    return Array.from(out);
  }

  /** Debug: particle 0 position in every history layer, newest first (slow readback). */
  sampleHistory(): number[][] {
    if (!this.history) return [];
    const target = floatTarget(1);
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: quadVertex,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp sampler2DArray;
        uniform sampler2DArray uHistory;
        uniform int uLayer;
        out vec4 outColor;
        void main() { outColor = texelFetch(uHistory, ivec3(0, 0, uLayer), 0); }
      `,
      uniforms: { uHistory: { value: this.history.texture }, uLayer: { value: 0 } },
    });
    const quad = new FullScreenQuad(material);
    const out: number[][] = [];
    const previous = this.renderer.getRenderTarget();
    for (let k = 0; k < this.layers; k += 1) {
      material.uniforms.uLayer.value = (this.head - k + this.layers) % this.layers;
      this.renderer.setRenderTarget(target);
      quad.render(this.renderer);
      const px = new Float32Array(4);
      this.renderer.readRenderTargetPixels(target, 0, 0, 1, 1, px);
      out.push(Array.from(px));
    }
    this.renderer.setRenderTarget(previous);
    quad.dispose();
    material.dispose();
    target.dispose();
    return out;
  }

  private disposeTargets(): void {
    this.state?.forEach((t) => t.dispose());
    this.history?.dispose();
    this.state = null;
    this.history = null;
  }

  dispose(): void {
    this.disposeTargets();
    this.object.geometry.dispose();
    this.simMaterial.dispose();
    this.copyMaterial.dispose();
    this.trailMaterial.dispose();
    this.simQuad.dispose();
    this.copyQuad.dispose();
  }
}
