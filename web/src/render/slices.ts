import * as THREE from "three";
import { colormapTexture } from "./colormaps";
import { GLSL_DOMAIN, domainUniforms, type Domain } from "./fields";

/**
 * GPU-sampled slices.
 *
 * Both the horizontal slice and the vertical section are plain quads whose fragment shader
 * converts the fragment's root-local position (km) to 3D texture coordinates and samples the
 * variable's Data3DTexture with hardware trilinear filtering. Moving / rotating a slice only
 * changes a transform or four vertices; the field data never leaves the GPU, so dragging
 * runs at full frame rate.
 */

export interface ScalarBinding {
  texture: THREE.Data3DTexture;
  /** physical value = sample(0..1) * 255 * scale + offset */
  scale: number;
  offset: number;
  log10: boolean;
}

export interface SliceStyle {
  colormap: string;
  min: number;
  max: number;
  opacity: number;
  contours: number; // 0 = off, else number of contour bands over [min, max]
}

const vertexShader = /* glsl */ `
uniform mat4 uRootInverse;
out vec3 vLocal;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vLocal = (uRootInverse * world).xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;
${GLSL_DOMAIN}
uniform sampler3D uField;
uniform sampler2D uColormap;
uniform float uScale;
uniform float uOffset;
uniform float uLog;
uniform float uMin;
uniform float uMax;
uniform float uFilterMin;
uniform float uFilterMax;
uniform float uFilterEnable;
uniform float uOpacity;
uniform float uContours;
uniform float uHighlight;
in vec3 vLocal;
out vec4 outColor;

void main() {
  if (!insideDomain(vLocal)) discard;
  float raw = texture(uField, localToTex(vLocal)).r * 255.0 * uScale + uOffset;
  float value = uLog > 0.5 ? pow(10.0, raw) : raw;
  if (uFilterEnable > 0.5 && (value < uFilterMin - 1e-6 || value > uFilterMax + 1e-6)) discard;
  float t = clamp((value - uMin) / max(uMax - uMin, 1e-9), 0.0, 1.0);
  vec3 color = texture(uColormap, vec2(t, 0.5)).rgb;
  if (uContours > 0.5) {
    // Anti-aliased iso-lines: distance to the nearest band edge in screen pixels.
    float bands = t * uContours;
    float d = abs(fract(bands - 0.5) - 0.5) / max(fwidth(bands), 1e-5);
    float line = 1.0 - smoothstep(0.0, 1.2, d);
    color = mix(color, color * 0.35, line * 0.55);
  }
  color = mix(color, vec3(1.0), uHighlight * 0.12);
  outColor = vec4(color, uOpacity);
}
`;

export class SliceMaterial extends THREE.ShaderMaterial {
  private composited = false;
  constructor(domain: Domain) {
    super({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        ...domainUniforms(domain),
        uRootInverse: { value: new THREE.Matrix4() },
        uField: { value: null },
        uColormap: { value: colormapTexture("viridis") },
        uScale: { value: 1 },
        uOffset: { value: 0 },
        uLog: { value: 0 },
        uMin: { value: 0 },
        uMax: { value: 1 },
        uFilterMin: { value: 0 },
        uFilterMax: { value: 1 },
        uFilterEnable: { value: 0 },
        uOpacity: { value: 0.9 },
        uContours: { value: 0 },
        uHighlight: { value: 0 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  /** root is scaled in y by the exaggeration: shaders need world → root-local. */
  setRoot(root: THREE.Object3D): void {
    (this.uniforms.uRootInverse.value as THREE.Matrix4).copy(root.matrixWorld).invert();
  }

  bind(field: ScalarBinding): void {
    this.uniforms.uField.value = field.texture;
    this.uniforms.uScale.value = field.scale;
    this.uniforms.uOffset.value = field.offset;
    this.uniforms.uLog.value = field.log10 ? 1 : 0;
  }

  style(style: SliceStyle): void {
    this.uniforms.uColormap.value = colormapTexture(style.colormap);
    this.uniforms.uMin.value = style.min;
    this.uniforms.uMax.value = style.max;
    this.uniforms.uOpacity.value = style.opacity;
    this.uniforms.uContours.value = style.contours;
    // Slices always write depth: particles behind a slice are hidden by it (drawn later),
    // opaque buildings are drawn earlier and stay visible through translucent slices.
    this.depthWrite = !this.composited;
    this.colorWrite = !this.composited;
  }

  setVolumeComposited(on: boolean): void {
    this.composited = on;
    this.colorWrite = !on;
    this.depthWrite = !on;
  }

  setFilter(min: number, max: number, enabled: boolean): void {
    this.uniforms.uFilterMin.value = Math.min(min, max);
    this.uniforms.uFilterMax.value = Math.max(min, max);
    this.uniforms.uFilterEnable.value = enabled ? 1 : 0;
  }
}

function outlineMaterial(color: number) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: true });
}

/** Horizontal slice at a given height (km). */
export class HorizontalSlice {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly material: SliceMaterial;
  readonly outline: THREE.LineLoop;

  constructor(private readonly domain: Domain) {
    this.material = new SliceMaterial(domain);
    const geometry = new THREE.PlaneGeometry(domain.sx, domain.sz);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.renderOrder = 2;
    this.mesh.userData.pickable = "slice";
    const hx = domain.sx / 2;
    const hz = domain.sz / 2;
    const ring = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-hx, 0, -hz),
      new THREE.Vector3(hx, 0, -hz),
      new THREE.Vector3(hx, 0, hz),
      new THREE.Vector3(-hx, 0, hz),
    ]);
    this.outline = new THREE.LineLoop(ring, outlineMaterial(0x9fe9ff));
    this.group.add(this.mesh, this.outline);
    this.group.name = "horizontal-slice";
  }

  setHeightKm(h: number): void {
    this.group.position.y = THREE.MathUtils.clamp(h, 0.0001, this.domain.top - 0.0001);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
  }
}

/**
 * Vertical section: a wall from the ground to the model top along a line through
 * `center` (x, z in km) with azimuth `azimuthDeg` (0° = north–south wall facing east,
 * 90° = east–west wall). The quad is clipped to the domain on the CPU (4 vertices).
 */
export class VerticalSection {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly material: SliceMaterial;
  readonly center = new THREE.Vector2(0, 0);
  azimuthDeg = 90;
  private readonly positions: Float32Array;
  readonly outline: THREE.LineLoop;
  private readonly outlinePositions: Float32Array;
  readonly handle: THREE.Mesh;

  constructor(private readonly domain: Domain) {
    this.material = new SliceMaterial(domain);
    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(12);
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.userData.pickable = "section";
    this.outlinePositions = new Float32Array(12);
    const ring = new THREE.BufferGeometry();
    ring.setAttribute("position", new THREE.BufferAttribute(this.outlinePositions, 3));
    this.outline = new THREE.LineLoop(ring, outlineMaterial(0xc8f6ff));
    this.outline.frustumCulled = false;
    // Drag handle: a small glowing bar on top of the wall.
    this.handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 0.6, 16).rotateZ(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x7cf3ff, transparent: true, opacity: 0.85 }),
    );
    this.handle.userData.pickable = "section";
    this.group.add(this.mesh, this.outline, this.handle);
    this.group.name = "vertical-section";
    this.update();
  }

  /** Unit vector along the wall in (x, z). */
  direction(): THREE.Vector2 {
    const a = THREE.MathUtils.degToRad(this.azimuthDeg);
    // azimuth measured clockwise from north; north is −z.
    return new THREE.Vector2(Math.sin(a), -Math.cos(a));
  }

  /** Unit normal of the wall in (x, z). */
  normal(): THREE.Vector2 {
    const d = this.direction();
    return new THREE.Vector2(-d.y, d.x);
  }

  setPlacement(center: THREE.Vector2, azimuthDeg: number): void {
    const hx = this.domain.sx / 2;
    const hz = this.domain.sz / 2;
    this.center.set(
      THREE.MathUtils.clamp(center.x, -hx, hx),
      THREE.MathUtils.clamp(center.y, -hz, hz),
    );
    this.azimuthDeg = azimuthDeg;
    this.update();
  }

  /** Signed offset of the wall from the domain centre along its normal (km). */
  offsetKm(): number {
    return this.center.dot(this.normal());
  }

  setOffset(offsetKm: number): void {
    this.setPlacement(this.normal().multiplyScalar(offsetKm), this.azimuthDeg);
  }

  /** Clip the infinite line center + t·dir against the domain rectangle (Liang–Barsky). */
  private chord(): [THREE.Vector2, THREE.Vector2] | null {
    const d = this.direction();
    const hx = this.domain.sx / 2;
    const hz = this.domain.sz / 2;
    let t0 = -Infinity;
    let t1 = Infinity;
    const clip = (p: number, dir: number, lo: number, hi: number) => {
      if (Math.abs(dir) < 1e-9) return p >= lo && p <= hi;
      let a = (lo - p) / dir;
      let b = (hi - p) / dir;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      return t0 <= t1;
    };
    if (!clip(this.center.x, d.x, -hx, hx) || !clip(this.center.y, d.y, -hz, hz)) return null;
    return [
      new THREE.Vector2(this.center.x + d.x * t0, this.center.y + d.y * t0),
      new THREE.Vector2(this.center.x + d.x * t1, this.center.y + d.y * t1),
    ];
  }

  private update(): void {
    const chord = this.chord();
    const top = this.domain.top;
    if (!chord) {
      this.group.visible = false;
      return;
    }
    const [a, b] = chord;
    const quad = [a.x, 0, a.y, b.x, 0, b.y, b.x, top, b.y, a.x, top, a.y];
    this.positions.set(quad);
    this.outlinePositions.set(quad);
    const geometry = this.mesh.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.computeBoundingSphere();
    this.outline.geometry.attributes.position.needsUpdate = true;
    this.handle.position.set((a.x + b.x) / 2, top, (a.y + b.y) / 2);
    this.handle.rotation.y = -THREE.MathUtils.degToRad(this.azimuthDeg) + Math.PI / 2;
  }

  /** Called every frame: keep the handle round although root is scaled in y. */
  setHandleScale(exaggeration: number): void {
    this.handle.scale.set(1, 1 / exaggeration, 1);
  }

  setHighlight(on: boolean): void {
    this.material.uniforms.uHighlight.value = on ? 1 : 0;
    (this.handle.material as THREE.MeshBasicMaterial).color.set(on ? 0xffffff : 0x7cf3ff);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    this.handle.geometry.dispose();
    (this.handle.material as THREE.Material).dispose();
  }
}
