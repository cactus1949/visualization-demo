import * as THREE from "three";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { SliceMaterial } from "../slices";
import type { Domain } from "../fields";
import { ANNOTATION_TOKENS as T, type AnnotationLayer } from "../annotations";
import { segmentsFor, type SectionGlobe } from "./globe";

type P3 = { x: number; y: number; z: number };

export interface BoxStackParams {
  x0: number; z0: number; x1: number; z1: number;
  levels?: number[]; heightMinM: number; heightMaxM: number;
  stepLevels: number;
  defined?: boolean;
  drawing?: boolean;
}

const LABEL_PREFIX = "box-label-";
const HANDLE_PREFIX = "box-corner-";
const OUTLINE_ID = "box-outline";

export class BoxStack {
  readonly group = new THREE.Group();
  readonly slabs = new THREE.Group();
  readonly depthTwins = new THREE.Group();
  readonly domain: Domain;
  readonly material: SliceMaterial;
  params: BoxStackParams;
  private layer: AnnotationLayer | null = null;
  private outlineVisible = false;
  private readonly haloMaterial: LineMaterial;
  private readonly faceMaterial: LineMaterial;
  private readonly hiddenMaterial: LineMaterial;
  private readonly haloLine: LineSegments2;
  private readonly faceLine: LineSegments2;
  private readonly hiddenLine: LineSegments2;
  private outlineKey = "";
  private readonly globe: SectionGlobe | null;
  /** Globe: box km -> scene (centre-ENU units), exact float64; used for the fat outline lines. */
  private place: ((p: P3) => P3) | null = null;

  constructor(domain: Domain, levels: number[], globe: SectionGlobe | null = null) {
    this.domain = domain;
    this.globe = globe;
    this.material = new SliceMaterial(domain, globe);
    // Push slabs back a little so the outline lying on the bottom slab's perimeter wins.
    this.material.polygonOffset = true;
    this.material.polygonOffsetFactor = 1;
    this.material.polygonOffsetUnits = 1;
    this.haloMaterial = new LineMaterial({
      color: 0x08141c,
      linewidth: T.sizes.boxHaloPx,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false,
    });
    this.faceMaterial = new LineMaterial({
      color: T.colors.fixed,
      linewidth: T.sizes.boxOutlinePx,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false,
    });
    this.hiddenMaterial = new LineMaterial({
      color: T.colors.fixed,
      linewidth: 1.5,
      transparent: true,
      opacity: 0.22,
      depthTest: true,
      depthWrite: false,
      depthFunc: THREE.GreaterDepth,
      dashed: true,
      dashSize: 0.06,
      gapSize: 0.05,
    });
    this.haloLine = this.makeLine(this.haloMaterial, "box-outline-halo");
    this.faceLine = this.makeLine(this.faceMaterial, "box-outline-face");
    this.hiddenLine = this.makeLine(this.hiddenMaterial, "box-outline-hidden");
    // Particles use renderOrder 10; draw depth twins and lines after them so the
    // stack's depth-only pass never hides particles behind translucent slabs.
    this.hiddenLine.renderOrder = 11;
    this.haloLine.renderOrder = 12;
    this.faceLine.renderOrder = 13;
    this.params = {
      x0: 0, z0: 0, x1: 0, z1: 0,
      levels, heightMinM: 0, heightMaxM: 1000, stepLevels: 1,
      defined: false, drawing: false,
    };
    this.group.add(this.slabs, this.depthTwins, this.hiddenLine, this.haloLine, this.faceLine);
    this.group.name = "box-stack";
    this.setResolution(1, 1);
  }

  private makeLine(material: LineMaterial, name: string): LineSegments2 {
    const line = new LineSegments2(new LineSegmentsGeometry(), material);
    line.name = name;
    line.frustumCulled = false;
    line.raycast = () => {};
    line.visible = false;
    return line;
  }

  setResolution(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.haloMaterial.resolution.set(w, h);
    this.faceMaterial.resolution.set(w, h);
    this.hiddenMaterial.resolution.set(w, h);
  }

  /** Globe: how outline points go from box km to the scene. Call refreshPlacement() when k / terrain change. */
  setPlacement(fn: ((p: P3) => P3) | null): void {
    this.place = fn;
    this.refreshPlacement();
  }

  /** Re-place the outline after a terrain or exaggeration change (surfaces follow the shared uniforms). */
  refreshPlacement(): void {
    this.outlineKey = "";
    if (this.params.defined && !this.params.drawing) this.rebuildOutline(true);
  }

  setAnnotationLayer(layer: AnnotationLayer | null): void {
    this.clearAnnotations();
    this.layer = layer;
    this.syncAnnotations();
  }

  /** Sort translucent slabs back-to-front in root-local space. */
  sortSlabs(camera: THREE.Camera, root: THREE.Object3D, camBox?: THREE.Vector3): void {
    if (this.slabs.children.length < 2) return;
    // globe: root-local is ENU, slabs are in box km -> the caller passes the camera in box km
    const cam = camBox ? camBox.clone() : root.worldToLocal(camera.position.clone());
    const items = this.slabs.children.slice();
    items.sort((a, b) => cam.distanceToSquared(b.position) - cam.distanceToSquared(a.position));
    for (let i = 0; i < items.length; i += 1) this.slabs.children[i] = items[i]!;
    const twins = this.depthTwins.children.slice();
    twins.sort((a, b) => cam.distanceToSquared(b.position) - cam.distanceToSquared(a.position));
    for (let i = 0; i < twins.length; i += 1) this.depthTwins.children[i] = twins[i]!;
  }

  update(p: BoxStackParams): void {
    this.params = {
      ...p,
      levels: p.levels ?? this.params.levels,
      stepLevels: Math.max(1, Math.round(p.stepLevels || 1)),
      defined: Boolean(p.defined),
      drawing: Boolean(p.drawing),
    };
    this.slabs.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.slabs.clear();
    this.depthTwins.traverse((o) => { if (o instanceof THREE.Mesh) o.material.dispose(); });
    this.depthTwins.clear();
    const ready = Boolean(this.params.defined || this.params.drawing);
    const area = Math.abs(this.params.x1 - this.params.x0) * Math.abs(this.params.z1 - this.params.z0);
    this.syncOutline(ready && area > 1e-6);
    if (!this.params.defined || area < 1e-6) {
      this.group.visible = this.outlineVisible;
      this.layer?.removePrefixed(LABEL_PREFIX);
      this.syncCorners();
      return;
    }
    const inRange = (this.params.levels ?? []).filter((h) => h >= this.params.heightMinM && h <= this.params.heightMaxM);
    const w = Math.abs(this.params.x1 - this.params.x0);
    const d = Math.abs(this.params.z1 - this.params.z0);
    const cx = (this.params.x0 + this.params.x1) / 2;
    const cz = (this.params.z0 + this.params.z1) / 2;
    const opaque = this.material.uniforms.uOpacity.value >= 0.999;
    this.material.depthWrite = opaque;
    this.material.colorWrite = true;
    for (let i = 0; i < inRange.length; i += this.params.stepLevels) {
      const h = inRange[i]!;
      const y = h / 1000;
      // globe: up to 160 x 160 cells per slab (a stack can have dozens of slabs)
      const g = this.globe ? new THREE.PlaneGeometry(w, d, segmentsFor(w, 160), segmentsFor(d, 160)) : new THREE.PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, this.material);
      m.position.set(cx, y, cz);
      m.renderOrder = 2;
      m.userData.levelM = h;
      m.userData.pickable = "box-stack";
      this.slabs.add(m);
      if (this.globe) {
        // placed in the vertex shader: box-km raycasts / culling would be wrong. No depth twins on
        // the globe: they exist for the box tabs' particles (⑤ is still off here).
        m.raycast = () => {};
        m.frustumCulled = false;
        continue;
      }
      const depth = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: 0xffffff,
        colorWrite: false,
        depthWrite: true,
        depthTest: true,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        transparent: true,
      }));
      depth.position.copy(m.position);
      depth.renderOrder = 10.5;
      depth.raycast = () => {};
      depth.userData.levelM = h;
      this.depthTwins.add(depth);
    }
    this.rebuildOutline(Boolean(this.params.defined));
    this.group.visible = this.slabs.children.length > 0 || this.outlineVisible;
    this.syncLabels();
    this.syncCorners();
  }

  syncAnnotations(): void {
    this.syncOutline(this.outlineVisible);
    this.syncLabels();
    this.syncCorners();
  }

  clearAnnotations(): void {
    this.layer?.remove(OUTLINE_ID);
    this.layer?.removePrefixed(LABEL_PREFIX);
    this.layer?.removePrefixed(HANDLE_PREFIX);
  }

  private syncOutline(on: boolean): void {
    const { x0, z0, x1, z1 } = this.params;
    this.outlineVisible = on;
    if (!on || !this.params.drawing) {
      this.layer?.remove(OUTLINE_ID);
    } else {
      this.layer?.addPolygon(OUTLINE_ID, [
        { x: x0, y: 0, z: z0 }, { x: x1, y: 0, z: z0 },
        { x: x1, y: 0, z: z1 }, { x: x0, y: 0, z: z1 },
      ], "preview", "box");
    }
    if (!on) {
      this.outlineKey = "";
      this.hideLines();
    }
  }

  private hideLines(): void {
    this.haloLine.visible = false;
    this.faceLine.visible = false;
    this.hiddenLine.visible = false;
  }

  private rebuildOutline(defined: boolean): void {
    const { x0, z0, x1, z1 } = this.params;
    const heights = this.layersInRange();
    const baseY = heights.length ? heights[0]! / 1000 : 0.002;
    const key = `${defined}:${x0}:${z0}:${x1}:${z1}:${baseY}:${this.params.heightMinM}:${this.params.heightMaxM}:${this.params.stepLevels}:${(this.params.levels ?? []).join(",")}`;
    if (!defined || this.params.drawing || key === this.outlineKey) {
      if (!defined || this.params.drawing) {
        this.outlineKey = "";
        this.hideLines();
      }
      return;
    }
    this.outlineKey = key;
    let positions = [
      x0, baseY, z0, x1, baseY, z0,
      x1, baseY, z0, x1, baseY, z1,
      x1, baseY, z1, x0, baseY, z1,
      x0, baseY, z1, x0, baseY, z0,
    ];
    if (this.globe && this.place) positions = this.placeOutline(positions);
    for (const line of [this.haloLine, this.faceLine, this.hiddenLine]) {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(positions);
      line.geometry.dispose();
      line.geometry = geometry;
      line.visible = true;
    }
    this.hiddenLine.computeLineDistances();
  }

  /** Globe: split each box-km edge so the line follows the shell, then place every point. */
  private placeOutline(edges: number[]): number[] {
    const out: number[] = [];
    for (let e = 0; e < edges.length; e += 6) {
      const ax = edges[e]!, ay = edges[e + 1]!, az = edges[e + 2]!;
      const bx = edges[e + 3]!, by = edges[e + 4]!, bz = edges[e + 5]!;
      const n = segmentsFor(Math.hypot(bx - ax, bz - az));
      let prev = this.place!({ x: ax, y: ay, z: az });
      for (let j = 1; j <= n; j++) {
        const t = j / n;
        const next = this.place!({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, z: az + (bz - az) * t });
        out.push(prev.x, prev.y, prev.z, next.x, next.y, next.z);
        prev = next;
      }
    }
    return out;
  }

  /** True when the camera-to-anchor segment crosses a displayed slab footprint. */
  occlusionTest = (camLocal: THREE.Vector3, anchor: THREE.Vector3): boolean => {
    if (!this.depthTwins.visible) return false;
    const minX = Math.min(this.params.x0, this.params.x1) + 1e-4;
    const maxX = Math.max(this.params.x0, this.params.x1) - 1e-4;
    const minZ = Math.min(this.params.z0, this.params.z1) + 1e-4;
    const maxZ = Math.max(this.params.z0, this.params.z1) - 1e-4;
    if (minX >= maxX || minZ >= maxZ) return false;
    const dy = anchor.y - camLocal.y;
    if (Math.abs(dy) < 1e-9) return false;
    for (const h of this.layersInRange()) {
      const t = (h / 1000 - camLocal.y) / dy;
      if (t <= 0 || t >= 0.999) continue;
      const x = camLocal.x + (anchor.x - camLocal.x) * t;
      const z = camLocal.z + (anchor.z - camLocal.z) * t;
      if (x > minX && x < maxX && z > minZ && z < maxZ) return true;
    }
    return false;
  };

  private layersInRange(): number[] {
    const step = this.params.stepLevels;
    return (this.params.levels ?? []).filter((h) => h >= this.params.heightMinM && h <= this.params.heightMaxM)
      .filter((_, i) => i % step === 0);
  }

  private syncLabels(): void {
    if (!this.layer) return;
    const visible = Boolean(this.params.defined && this.group.visible && this.slabs.children.length);
    if (!visible) {
      this.layer.removePrefixed(LABEL_PREFIX);
      return;
    }
    const cx = (this.params.x0 + this.params.x1) / 2;
    const cz = (this.params.z0 + this.params.z1) / 2;
    const used = new Set<string>();
    const heights = this.layersInRange();
    heights.forEach((h, i) => {
      const y = h / 1000;
      const id = `${LABEL_PREFIX}${i}`;
      used.add(id);
      this.layer!.addLabel(id, {
        anchor: { x: this.params.x0, y, z: this.params.z0 },
        space: "box",
        text: `${h.toFixed(1)} m`,
        leader: true,
        awayFrom: { x: cx, y, z: cz },
        priority: h,
        cluster: "box-height",
        visible: true,
      });
    });
    for (let i = heights.length; i < 48; i += 1) this.layer.remove(`${LABEL_PREFIX}${i}`);
  }

  private syncCorners(): void {
    if (!this.layer) return;
    const visible = Boolean((this.params.defined || this.params.drawing) && Math.abs(this.params.x1 - this.params.x0) * Math.abs(this.params.z1 - this.params.z0) > 1e-6);
    const corners = [
      { x: this.params.x0, z: this.params.z0 },
      { x: this.params.x1, z: this.params.z0 },
      { x: this.params.x1, z: this.params.z1 },
      { x: this.params.x0, z: this.params.z1 },
    ];
    if (!visible) {
      this.layer.removePrefixed(HANDLE_PREFIX);
      return;
    }
    corners.forEach((c, i) => {
      this.layer!.addHandle(`${HANDLE_PREFIX}${i}`, {
        anchor: { x: c.x, y: this.params.defined ? this.outlineY() : 0, z: c.z },
        space: "box",
        role: this.params.drawing ? "preview" : "fixed",
        draggable: Boolean(this.params.defined),
        visible: true,
        occlusionTest: this.params.defined ? this.occlusionTest : undefined,
        userData: { pickable: "box-corner", index: i },
      });
    });
  }

  private outlineY(): number {
    const heights = this.layersInRange();
    return heights.length ? heights[0]! / 1000 : 0.002;
  }

  dispose(): void {
    this.material.dispose();
    this.slabs.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.haloLine.geometry.dispose();
    this.faceLine.geometry.dispose();
    this.hiddenLine.geometry.dispose();
    this.haloMaterial.dispose();
    this.faceMaterial.dispose();
    this.hiddenMaterial.dispose();
    this.depthTwins.traverse((o) => { if (o instanceof THREE.Mesh) o.material.dispose(); });
    this.clearAnnotations();
  }
}
