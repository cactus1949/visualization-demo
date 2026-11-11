import * as THREE from "three";
import { SliceMaterial } from "../slices";
import type { Domain } from "../fields";
import type { AnnotationLayer } from "../annotations";

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
  readonly domain: Domain;
  readonly material: SliceMaterial;
  params: BoxStackParams;
  private layer: AnnotationLayer | null = null;
  private outlineVisible = false;

  constructor(domain: Domain, levels: number[]) {
    this.domain = domain;
    this.material = new SliceMaterial(domain);
    this.params = {
      x0: 0, z0: 0, x1: 0, z1: 0,
      levels, heightMinM: 0, heightMaxM: 1000, stepLevels: 1,
      defined: false, drawing: false,
    };
    this.group.add(this.slabs);
    this.group.name = "box-stack";
  }

  setAnnotationLayer(layer: AnnotationLayer | null): void {
    this.clearAnnotations();
    this.layer = layer;
    this.syncAnnotations();
  }

  /** Sort translucent slabs back-to-front in root-local space. */
  sortSlabs(camera: THREE.Camera, root: THREE.Object3D): void {
    if (this.slabs.children.length < 2) return;
    const cam = root.worldToLocal(camera.position.clone());
    const items = this.slabs.children.slice();
    items.sort((a, b) => cam.distanceToSquared(b.position) - cam.distanceToSquared(a.position));
    for (let i = 0; i < items.length; i += 1) this.slabs.children[i] = items[i]!;
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
      const g = new THREE.PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, this.material);
      m.position.set(cx, y, cz);
      m.renderOrder = 2;
      m.userData.levelM = h;
      m.userData.pickable = "box-stack";
      this.slabs.add(m);
    }
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
    if (!on) {
      this.layer?.remove(OUTLINE_ID);
      return;
    }
    this.layer?.addPolygon(OUTLINE_ID, [
      { x: x0, y: 0, z: z0 }, { x: x1, y: 0, z: z0 },
      { x: x1, y: 0, z: z1 }, { x: x0, y: 0, z: z1 },
    ], this.params.drawing ? "preview" : "fixed");
  }

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
        anchor: { x: c.x, y: 0, z: c.z },
        role: this.params.drawing ? "preview" : "fixed",
        draggable: Boolean(this.params.defined),
        visible: true,
        userData: { pickable: "box-corner", index: i },
      });
    });
  }

  dispose(): void {
    this.material.dispose();
    this.slabs.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.clearAnnotations();
  }
}
