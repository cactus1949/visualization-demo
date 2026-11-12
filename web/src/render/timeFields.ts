import * as THREE from "three";
import type { Domain } from "./fields";

/**
 * Time-dependent 3D fields on the GPU.
 *
 * Every resource (the packed wind, each scalar in use) owns up to SLOTS half-float
 * `DataArrayTexture`s holding whole frames (A = ⌊t⌋, B = ⌊t⌋+1, C = prefetch) and ONE
 * `WebGL3DRenderTarget` that all consumers sample. A blend pass writes
 * mix(A, B, s) into that target, layer by layer, only when (A, B, s) changes, so
 * particles, volume, slices, sections, polyline walls, box stacks and cut faces all see
 * the same instant and never need to rebind. Wind uses magnitude-preserving
 * interpolation (direction from the mixed vector, length = mix of lengths); the derived
 * horizontal speed is mix(|V_A|, |V_B|, s), consistent with the wind target.
 *
 * Slot refills after the first allocation are uploaded a few layers per animation frame
 * (`layerUpdates`, texSubImage3D per layer) so crossing an hour boundary never uploads a
 * whole 28.8 MB frame inside one rendered frame.
 */
const SLOTS = 3;
/** layers uploaded per rendered frame when refilling a slot (wind: 4 MB / frame) */
const LAYERS_PER_FRAME = 6;

type Mode = 0 | 1 | 2; // 0 wind (RGBA), 1 speed from wind slots (R), 2 scalar (R)

interface Slot {
  tex: THREE.DataArrayTexture | null;
  frame: number;
  /** next layer to upload; >= nz means resident */
  next: number;
  data: Uint16Array | null;
}

const VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uA;
uniform sampler2DArray uB;
uniform float uS;
uniform int uLayer;
uniform int uMode;
out vec4 outColor;
void main() {
  ivec3 c = ivec3(int(gl_FragCoord.x), int(gl_FragCoord.y), uLayer);
  vec4 a = texelFetch(uA, c, 0);
  vec4 b = texelFetch(uB, c, 0);
  if (uMode == 2) {
    outColor = vec4(mix(a.r, b.r, uS), 0.0, 0.0, 1.0);
    return;
  }
  float ma = length(a.xy);
  float mb = length(b.xy);
  float m = mix(ma, mb, uS);
  if (uMode == 1) {
    outColor = vec4(m, 0.0, 0.0, 1.0);
    return;
  }
  vec2 uv = mix(a.xy, b.xy, uS);
  float l = length(uv);
  if (l > 1e-5) uv *= m / l;
  outColor = vec4(uv, mix(a.z, b.z, uS), m);
}
`;

export class TimeResource {
  readonly slots: Slot[] = [];
  readonly target: THREE.WebGL3DRenderTarget;
  /** true once the target holds a blended field */
  valid = false;
  /** (a, b, s) shown in the target */
  shown = { a: -1, b: -1, s: -1 };
  /** wall time of the first full slot upload (ms) */
  firstUploadMs: number | null = null;
  lastUsed = 0;

  constructor(
    readonly name: string,
    readonly channels: 1 | 4,
    private readonly d: Domain,
  ) {
    for (let i = 0; i < SLOTS; i += 1) this.slots.push({ tex: null, frame: -1, next: 0, data: null });
    this.target = new THREE.WebGL3DRenderTarget(d.nx, d.ny, d.nz, {
      format: channels === 4 ? THREE.RGBAFormat : THREE.RedFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    const t = this.target.texture;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.minFilter = t.magFilter = THREE.LinearFilter;
  }

  get texture(): THREE.Data3DTexture {
    return this.target.texture as unknown as THREE.Data3DTexture;
  }

  resident(frame: number): boolean {
    return this.slots.some((s) => s.frame === frame && s.tex !== null && s.next >= this.d.nz);
  }

  /** Slot holding (or filling) `frame`. */
  holds(frame: number): boolean {
    return this.slots.some((s) => s.frame === frame);
  }

  slotOf(frame: number): Slot | undefined {
    return this.slots.find((s) => s.frame === frame && s.tex !== null && s.next >= this.d.nz);
  }

  /**
   * Queue `data` (one frame, half floats) for a slot. Frames in `keep` are never evicted.
   * Returns false when every slot is protected.
   */
  offer(frame: number, data: Uint16Array, keep: number[]): boolean {
    if (this.holds(frame)) return true;
    let victim = this.slots.find((s) => s.frame < 0);
    if (!victim) {
      // evict the least useful frame: not protected, farthest from the protected ones
      let best = -1;
      for (const s of this.slots) {
        if (keep.includes(s.frame)) continue;
        const dist = Math.min(...keep.map((k) => Math.abs(k - s.frame)), 99);
        if (dist > best) {
          best = dist;
          victim = s;
        }
      }
    }
    if (!victim) return false;
    victim.frame = frame;
    victim.data = data;
    victim.next = 0;
    if (this.shown.a === frame || this.shown.b === frame) this.shown.a = -1; // force re-blend later
    return true;
  }

  /** Upload pending slot data; returns the number of layers uploaded. */
  pump(renderer: THREE.WebGLRenderer, budgetLayers: number): number {
    const d = this.d;
    let used = 0;
    for (const s of this.slots) {
      if (!s.data || s.next >= d.nz) continue;
      if (!s.tex) {
        // first allocation: three allocates storage and uploads the whole frame once
        const t0 = performance.now();
        const tex = new THREE.DataArrayTexture(s.data, d.nx, d.ny, d.nz);
        tex.format = this.channels === 4 ? THREE.RGBAFormat : THREE.RedFormat;
        tex.type = THREE.HalfFloatType;
        tex.minFilter = tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.unpackAlignment = 1;
        tex.needsUpdate = true;
        renderer.initTexture(tex);
        s.tex = tex;
        s.next = d.nz;
        if (this.firstUploadMs === null) this.firstUploadMs = performance.now() - t0;
      } else {
        const tex = s.tex;
        tex.image.data = s.data as unknown as Uint8Array;
        const end = Math.min(d.nz, s.next + Math.max(1, budgetLayers - used));
        for (let k = s.next; k < end; k += 1) tex.addLayerUpdate(k);
        used += end - s.next;
        s.next = end;
        tex.needsUpdate = true;
        renderer.initTexture(tex);
      }
      if (s.next >= d.nz) {
        // the GPU copy is complete; drop the CPU copy (a later refill brings new data)
        s.data = null;
        if (s.tex) (s.tex.image as { data: unknown }).data = null;
      }
      if (used >= budgetLayers) break;
    }
    return used;
  }

  dispose(): void {
    this.target.dispose();
    for (const s of this.slots) s.tex?.dispose();
  }
}

export class TimeFields {
  readonly wind: TimeResource;
  readonly scalars = new Map<string, TimeResource>();
  /** derived horizontal speed: blended from the wind slots, no slots of its own */
  readonly speed: THREE.WebGL3DRenderTarget;
  speedValid = false;
  private speedShown = { a: -1, b: -1, s: -1 };
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly material: THREE.RawShaderMaterial;
  /** last blend pass cost in ms (CPU side, incl. draw submission) */
  lastBlendMs = 0;
  blendCount = 0;
  uploadedLayers = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly d: Domain,
  ) {
    this.wind = new TimeResource("wind", 4, d);
    this.speed = new THREE.WebGL3DRenderTarget(d.nx, d.ny, d.nz, {
      format: THREE.RedFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    const st = this.speed.texture;
    st.wrapS = st.wrapT = st.wrapR = THREE.ClampToEdgeWrapping;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uA: { value: null },
        uB: { value: null },
        uS: { value: 0 },
        uLayer: { value: 0 },
        uMode: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  scalar(name: string): TimeResource {
    let r = this.scalars.get(name);
    if (!r) {
      r = new TimeResource(name, 1, this.d);
      this.scalars.set(name, r);
    }
    return r;
  }

  get speedTexture(): THREE.Data3DTexture {
    return this.speed.texture as unknown as THREE.Data3DTexture;
  }

  /** Upload slot data with a per-frame layer budget shared by all resources. */
  pump(budget = LAYERS_PER_FRAME): void {
    let left = budget;
    for (const r of [this.wind, ...this.scalars.values()]) {
      if (left <= 0) break;
      const used = r.pump(this.renderer, left);
      left -= used;
      this.uploadedLayers += used;
    }
  }

  /**
   * Blend frames (a, b, s) into the targets of `resources` (and the speed target when
   * `speed`). A resource whose slots are not resident keeps its previous content.
   * Returns true when every requested resource shows exactly (a, b, s).
   */
  blend(a: number, b: number, s: number, resources: TimeResource[], speed: boolean): boolean {
    const t0 = performance.now();
    let all = true;
    let drew = false;
    const prev = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    const u = this.material.uniforms;
    const run = (target: THREE.WebGL3DRenderTarget, A: THREE.Texture, B: THREE.Texture, mode: Mode) => {
      u.uA!.value = A;
      u.uB!.value = B;
      u.uS!.value = s;
      u.uMode!.value = mode;
      for (let k = 0; k < this.d.nz; k += 1) {
        u.uLayer!.value = k;
        this.renderer.setRenderTarget(target, k);
        this.renderer.render(this.scene, this.camera);
      }
      drew = true;
    };
    for (const r of resources) {
      if (r.shown.a === a && r.shown.b === b && r.shown.s === s && r.valid) continue;
      const A = r.slotOf(a);
      const B = s > 0 ? r.slotOf(b) : A;
      if (!A?.tex || !B?.tex) {
        all = false;
        continue;
      }
      run(r.target, A.tex, B.tex, r.channels === 4 ? 0 : 2);
      r.valid = true;
      r.shown = { a, b, s };
    }
    if (speed) {
      const sh = this.speedShown;
      if (!(sh.a === a && sh.b === b && sh.s === s && this.speedValid)) {
        const A = this.wind.slotOf(a);
        const B = s > 0 ? this.wind.slotOf(b) : A;
        if (A?.tex && B?.tex) {
          run(this.speed, A.tex, B.tex, 1);
          this.speedValid = true;
          this.speedShown = { a, b, s };
        } else all = false;
      }
    }
    this.renderer.setRenderTarget(prev);
    this.renderer.autoClear = prevAutoClear;
    if (drew) {
      this.lastBlendMs = performance.now() - t0;
      this.blendCount += 1;
    }
    return all;
  }

  /** Read one texel of a "current time" target (debug / verification only). */
  readTexel(target: THREE.WebGL3DRenderTarget, ix: number, iy: number, k: number): number[] {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target, k);
    const out = new Float32Array(4);
    gl.readPixels(ix, iy, 1, 1, gl.RGBA, gl.FLOAT, out);
    this.renderer.setRenderTarget(prev);
    return [...out];
  }

  /** Force the next blend of every target (e.g. after the smoothing switch). */
  invalidate(): void {
    this.wind.shown.a = -1;
    for (const r of this.scalars.values()) r.shown.a = -1;
    this.speedShown.a = -1;
  }

  /** GPU bytes held by slots and targets (approximate). */
  gpuBytes(): number {
    const vox = this.d.nx * this.d.ny * this.d.nz;
    let bytes = vox * 2 * 4 + vox * 2; // wind target + speed target
    for (const s of this.wind.slots) if (s.tex) bytes += vox * 2 * 4;
    for (const r of this.scalars.values()) {
      bytes += vox * 2;
      for (const s of r.slots) if (s.tex) bytes += vox * 2;
    }
    return bytes;
  }

  disposeScalar(name: string): void {
    this.scalars.get(name)?.dispose();
    this.scalars.delete(name);
  }

  dispose(): void {
    this.wind.dispose();
    this.speed.dispose();
    for (const r of this.scalars.values()) r.dispose();
    this.scalars.clear();
    this.material.dispose();
  }
}
