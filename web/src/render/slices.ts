import * as THREE from "three";
import type { AnnotationLayer } from "./annotations";
import { colormapTexture } from "./colormaps";
import { GLSL_DOMAIN, domainUniforms, type Domain } from "./fields";
import { LOGDEPTH_FRAGMENT, LOGDEPTH_FRAGMENT_PARS } from "../globe/geoShader";
import { GlobeLineMaterial, densifyLoop, globeSectionVertex, gridQuad, segmentsFor, type SectionGlobe } from "./sections/globe";

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
  /** Values are physical floats in the half-float texture. */
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
  /** Value-based alpha: normalized t below `lowThreshold` fades to transparent. */
  lowAlpha?: boolean;
  lowThreshold?: number;
}

/** Shared ramp width above the low-alpha threshold (normalized units). */
export const LOW_ALPHA_RAMP = 0.25;
/** Value-based alpha used by every section surface (GLSL). */
export const GLSL_LOW_ALPHA = /* glsl */ `
float lowAlphaFactor(float t, float on, float thr) {
  if (on < 0.5) return 1.0;
  return smoothstep(thr, min(1.0, thr + ${LOW_ALPHA_RAMP.toFixed(2)}), t);
}
`;

const vertexShader = /* glsl */ `
uniform mat4 uRootInverse;
out vec3 vLocal;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vLocal = (uRootInverse * world).xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

function sliceFragment(globe: boolean): string {
  return /* glsl */ `
precision highp float;
precision highp sampler3D;
${globe ? LOGDEPTH_FRAGMENT_PARS : ""}${GLSL_DOMAIN}
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
uniform float uLowAlpha;
uniform float uLowThreshold;
${GLSL_LOW_ALPHA}
in vec3 vLocal;
out vec4 outColor;

void main() {${globe ? LOGDEPTH_FRAGMENT : ""}
  if (!insideDomain(vLocal)) discard;
  float value = texture(uField, localToTex(vLocal)).r;
  if (isnan(value)) discard;
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
  float alpha = uOpacity * lowAlphaFactor(t, uLowAlpha, uLowThreshold);
  if (alpha < 0.004) discard;
  outColor = vec4(color, alpha);
}
`;
}
const fragmentShader = sliceFragment(false);

export class SliceMaterial extends THREE.ShaderMaterial {
  private composited = false;
  lowAlpha = false;
  /** Globe tab: placed on the curved shell (render/sections/globe.ts); null on the box tabs. */
  readonly globe: SectionGlobe | null;
  constructor(domain: Domain, globe: SectionGlobe | null = null) {
    super({
      glslVersion: THREE.GLSL3,
      vertexShader: globe ? globeSectionVertex(globe.map) : vertexShader,
      fragmentShader: globe ? sliceFragment(true) : fragmentShader,
      uniforms: {
        ...(globe ? globe.geo : {}),
        ...domainUniforms(domain),
        uRootInverse: { value: new THREE.Matrix4() },
        ...(globe ? { uRootMatrix: { value: new THREE.Matrix4() } } : {}),
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
        uLowAlpha: { value: 0 },
        uLowThreshold: { value: 0.15 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.globe = globe;
  }

  /** root is scaled in y by the exaggeration: shaders need world → root-local. */
  setRoot(root: THREE.Object3D): void {
    (this.uniforms.uRootInverse.value as THREE.Matrix4).copy(root.matrixWorld).invert();
    if (this.globe) (this.uniforms.uRootMatrix.value as THREE.Matrix4).copy(root.matrixWorld);
  }

  bind(field: ScalarBinding): void {
    this.uniforms.uField.value = field.texture;
    this.uniforms.uScale.value = 1;
    this.uniforms.uOffset.value = 0;
    this.uniforms.uLog.value = 0;
  }

  style(style: SliceStyle): void {
    this.uniforms.uColormap.value = colormapTexture(style.colormap);
    const lo = Number.isFinite(style.min) ? style.min : 0;
    const hi = Number.isFinite(style.max) && style.max !== lo ? style.max : lo + 1;
    this.uniforms.uMin.value = Math.min(lo, hi);
    this.uniforms.uMax.value = Math.max(lo, hi);
    this.uniforms.uOpacity.value = style.opacity;
    this.uniforms.uContours.value = style.contours;
    this.uniforms.uLowAlpha.value = style.lowAlpha ? 1 : 0;
    this.uniforms.uLowThreshold.value = style.lowThreshold ?? 0.15;
    this.lowAlpha = Boolean(style.lowAlpha);
    // Slices always write depth: particles behind a slice are hidden by it (drawn later),
    // opaque buildings are drawn earlier and stay visible through translucent slices.
    // With value-based alpha, depth writes would let a mostly-transparent slab hide
    // everything behind it; translucent surfaces rely on back-to-front sorting instead.
    this.depthWrite = !this.composited && !this.lowAlpha;
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
  private layer: AnnotationLayer | null = null;
  private readonly handleId = "height-handle";
  private readonly readoutId = "height-readout";
  private handlesOn = false;

  constructor(private readonly domain: Domain, private readonly globe: SectionGlobe | null = null) {
    this.material = new SliceMaterial(domain, globe);
    const geometry = globe
      // one quad per grid cell: vertices sit on the ground-grid nodes the terrain is defined on
      ? new THREE.PlaneGeometry(domain.sx, domain.sz, Math.max(1, domain.nx - 1), Math.max(1, domain.ny - 1))
      : new THREE.PlaneGeometry(domain.sx, domain.sz);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.renderOrder = 2;
    this.mesh.userData.pickable = "slice";
    const hx = domain.sx / 2;
    const hz = domain.sz / 2;
    const corners = [
      new THREE.Vector3(-hx, 0, -hz),
      new THREE.Vector3(hx, 0, -hz),
      new THREE.Vector3(hx, 0, hz),
      new THREE.Vector3(-hx, 0, hz),
    ];
    if (globe) {
      // box-km geometry: CPU raycasts and bounding spheres would be in the wrong space
      this.mesh.raycast = () => {};
      this.mesh.frustumCulled = false;
      const ring = new THREE.BufferGeometry();
      ring.setAttribute("position", new THREE.BufferAttribute(densifyLoop(corners, segmentsFor(Math.max(domain.sx, domain.sz))), 3));
      this.outline = new THREE.LineLoop(ring, new GlobeLineMaterial(domain, globe, 0x9fe9ff));
      this.outline.frustumCulled = false;
      this.outline.raycast = () => {};
    } else {
      const ring = new THREE.BufferGeometry().setFromPoints(corners);
      this.outline = new THREE.LineLoop(ring, outlineMaterial(0x9fe9ff));
    }
    this.group.add(this.mesh, this.outline);
    this.group.name = "horizontal-slice";
  }

  /** Per frame, after root's matrix update (globe outline needs it too). */
  setRoot(root: THREE.Object3D): void {
    this.material.setRoot(root);
    if (this.globe) (this.outline.material as GlobeLineMaterial).setRoot(root);
  }

  setHeightKm(h: number): void {
    this.group.position.y = THREE.MathUtils.clamp(h, 0.0001, this.domain.top - 0.0001);
    this.syncHandle();
  }

  setAnnotationLayer(layer: AnnotationLayer | null): void {
    this.layer = layer;
    this.syncHandle();
  }

  setHandleVisible(on: boolean): void {
    this.handlesOn = on;
    if (!on) {
      this.layer?.remove(this.handleId);
      this.layer?.setVisible(this.readoutId, false);
      return;
    }
    this.syncHandle();
  }

  setDragging(on: boolean, heightM?: number): void {
    if (!this.layer) return;
    this.layer.setState(this.handleId, on ? "dragging" : "idle");
    if (on && heightM !== undefined) {
      this.layer.addLabel(this.readoutId, {
        anchor: this.handleAnchor(),
        space: "box",
        text: `${heightM.toFixed(1)} m`,
        leader: false,
        visible: true,
        priority: 10_000,
      });
    } else {
      this.layer.setVisible(this.readoutId, false);
    }
  }

  syncAnnotations(): void {
    this.syncHandle();
  }

  private handleAnchor(): { x: number; y: number; z: number } {
    return { x: this.domain.sx / 2, y: this.group.position.y, z: 0 };
  }

  private syncHandle(): void {
    if (!this.layer) return;
    const visible = this.handlesOn && this.group.visible;
    if (!visible) {
      this.layer.remove(this.handleId);
      this.layer.setVisible(this.readoutId, false);
      return;
    }
    this.layer.addHandle(this.handleId, {
      anchor: this.handleAnchor(),
      space: "box",
      role: "fixed",
      variant: "grip",
      axis: "y",
      draggable: true,
      visible: true,
      userData: { pickable: "height-handle" },
    });
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    this.layer?.remove(this.handleId);
    this.layer?.remove(this.readoutId);
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
  private layer: AnnotationLayer | null = null;
  private readonly handleId = "section-handle";
  private readonly readoutId = "section-readout";
  private dragging = false;
  private handlesOn = false;

  /** Globe: wall subdivided along its chord (and a few rows up) so it follows the curved shell. */
  private readonly globeCols: number;
  private static readonly GLOBE_ROWS = 4;

  constructor(private readonly domain: Domain, private readonly globe: SectionGlobe | null = null) {
    this.material = new SliceMaterial(domain, globe);
    const geometry = new THREE.BufferGeometry();
    this.globeCols = globe ? segmentsFor(Math.hypot(domain.sx, domain.sz)) : 1;
    this.positions = new Float32Array(12);
    if (!globe) {
      geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
    }
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.userData.pickable = "section";
    const ring = new THREE.BufferGeometry();
    if (globe) {
      this.mesh.raycast = () => {};
      this.outlinePositions = new Float32Array(4 * this.globeCols * 3);
      ring.setAttribute("position", new THREE.BufferAttribute(this.outlinePositions, 3));
      this.outline = new THREE.LineLoop(ring, new GlobeLineMaterial(domain, globe, 0xc8f6ff));
      this.outline.raycast = () => {};
    } else {
      this.outlinePositions = new Float32Array(12);
      ring.setAttribute("position", new THREE.BufferAttribute(this.outlinePositions, 3));
      this.outline = new THREE.LineLoop(ring, outlineMaterial(0xc8f6ff));
    }
    this.outline.frustumCulled = false;
    this.group.add(this.mesh, this.outline);
    this.group.name = "vertical-section";
    this.update();
  }

  /** Per frame, after root's matrix update (globe outline needs it too). */
  setRoot(root: THREE.Object3D): void {
    this.material.setRoot(root);
    if (this.globe) (this.outline.material as GlobeLineMaterial).setRoot(root);
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
      this.clearHandle();
      return;
    }
    const [a, b] = chord;
    const quad = [a.x, 0, a.y, b.x, 0, b.y, b.x, top, b.y, a.x, top, a.y];
    this.positions.set(quad);
    if (this.globe) {
      const a0 = new THREE.Vector3(a.x, 0, a.y), b0 = new THREE.Vector3(b.x, 0, b.y);
      const b1 = new THREE.Vector3(b.x, top, b.y), a1 = new THREE.Vector3(a.x, top, a.y);
      gridQuad(a0, b0, b1, a1, this.globeCols, VerticalSection.GLOBE_ROWS, this.mesh.geometry);
      this.outlinePositions.set(densifyLoop([a0, b0, b1, a1], this.globeCols));
    } else {
      this.outlinePositions.set(quad);
      const geometry = this.mesh.geometry;
      geometry.attributes.position.needsUpdate = true;
      geometry.computeBoundingSphere();
    }
    this.outline.geometry.attributes.position.needsUpdate = true;
    this.syncHandle((a.x + b.x) / 2, top, (a.y + b.y) / 2);
  }

  setAnnotationLayer(layer: AnnotationLayer | null): void {
    this.layer = layer;
    this.update();
  }

  /** Screen-space handles ignore vertical exaggeration; kept as a no-op for callers. */
  setHandleScale(_exaggeration: number): void {}

  setHandleVisible(on: boolean): void {
    this.handlesOn = on;
    if (!on) {
      this.clearHandle();
      return;
    }
    this.update();
  }

  setHighlight(on: boolean): void {
    this.material.uniforms.uHighlight.value = on ? 1 : 0;
    if (this.layer && !this.dragging) this.layer.setState(this.handleId, on ? "hover" : "idle");
  }

  setDragging(on: boolean, offsetKm?: number): void {
    if (!this.layer) return;
    this.dragging = on;
    this.layer.setState(this.handleId, on ? "dragging" : "idle");
    if (on && offsetKm !== undefined) {
      const chord = this.chord();
      const mid = chord
        ? { x: (chord[0].x + chord[1].x) / 2, y: this.domain.top, z: (chord[0].y + chord[1].y) / 2 }
        : { x: this.center.x, y: this.domain.top, z: this.center.y };
      this.layer.addLabel(this.readoutId, {
        anchor: mid,
        space: "box",
        text: `${offsetKm.toFixed(2)} km`,
        leader: false,
        visible: true,
        priority: 10_000,
      });
    } else {
      this.layer.setVisible(this.readoutId, false);
    }
  }

  syncAnnotations(): void {
    if (!this.handlesOn || !this.group.visible) this.clearHandle();
    else this.update();
  }

  private clearHandle(): void {
    this.layer?.remove(this.handleId);
    this.layer?.setVisible(this.readoutId, false);
  }

  private syncHandle(x: number, y: number, z: number): void {
    if (!this.layer) return;
    if (!this.handlesOn || !this.group.visible) {
      this.clearHandle();
      return;
    }
    const lon = Math.abs(this.azimuthDeg % 180) < 45 || Math.abs(this.azimuthDeg % 180) > 135;
    this.layer.addHandle(this.handleId, {
      anchor: { x, y, z },
      space: "box",
      role: "fixed",
      variant: "grip",
      axis: lon ? "x" : "z",
      draggable: true,
      visible: true,
      userData: { pickable: "section" },
    });
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    this.layer?.remove(this.handleId);
    this.layer?.remove(this.readoutId);
  }
}
