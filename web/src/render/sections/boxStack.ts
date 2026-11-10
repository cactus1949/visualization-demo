import * as THREE from "three";
import { SliceMaterial } from "../slices";
import type { Domain } from "../fields";
import type { AnnotationLayer } from "../annotations";

export interface BoxStackParams {
  x0: number; z0: number; x1: number; z1: number;
  levels: number[]; heightMinM: number; heightMaxM: number;
  stepLevels: number; stretch: number; spacingKm: number;
}

const LABEL_PREFIX = "box-label-";

export class BoxStack {
  readonly group = new THREE.Group();
  readonly slabs = new THREE.Group();
  readonly domain: Domain;
  readonly material: SliceMaterial;
  params: BoxStackParams;
  private layer: AnnotationLayer | null = null;

  constructor(domain: Domain, levels: number[]) {
    this.domain = domain;
    this.material = new SliceMaterial(domain);
    this.params = { x0: -2, z0: -2, x1: 2, z1: 2, levels, heightMinM: 100, heightMaxM: 300, stepLevels: 5, stretch: 1, spacingKm: 0 };
    this.group.add(this.slabs);
    this.group.name = "box-stack";
    this.update(this.params);
  }

  setAnnotationLayer(layer: AnnotationLayer | null): void {
    this.layer = layer;
    this.syncLabels();
  }

  update(p: BoxStackParams): void {
    this.params = { ...p, stepLevels: Math.max(1, Math.round(p.stepLevels || 1)) };
    this.slabs.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.slabs.clear();
    let count = 0;
    const inRange = this.params.levels.filter((h) => h >= this.params.heightMinM && h <= this.params.heightMaxM);
    for (let i = 0; i < inRange.length && count < 16; i += this.params.stepLevels) {
      const h = inRange[i];
      const y = h / 1000 * this.params.stretch + count * this.params.spacingKm;
      const g = new THREE.PlaneGeometry(Math.abs(this.params.x1 - this.params.x0), Math.abs(this.params.z1 - this.params.z0));
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, this.material);
      m.position.set((this.params.x0 + this.params.x1) / 2, y, (this.params.z0 + this.params.z1) / 2);
      m.userData.levelM = h; m.userData.pickable = "box-stack";
      this.slabs.add(m);
      count += 1;
    }
    this.group.visible = count > 0;
    this.syncLabels();
  }

  syncAnnotations(): void {
    this.syncLabels();
  }

  private syncLabels(): void {
    if (!this.layer) return;
    const visible = this.group.visible;
    const cx = (this.params.x0 + this.params.x1) / 2;
    const cz = (this.params.z0 + this.params.z1) / 2;
    let count = 0;
    const inRange = this.params.levels.filter((h) => h >= this.params.heightMinM && h <= this.params.heightMaxM);
    const used = new Set<string>();
    for (let i = 0; i < inRange.length && count < 16; i += this.params.stepLevels) {
      const h = inRange[i];
      const y = h / 1000 * this.params.stretch + count * this.params.spacingKm;
      const id = `${LABEL_PREFIX}${count}`;
      used.add(id);
      this.layer.addLabel(id, {
        anchor: { x: this.params.x0, y, z: this.params.z0 },
        text: `${h.toFixed(1)} m`,
        leader: true,
        awayFrom: { x: cx, y, z: cz },
        priority: h,
        visible,
      });
      count += 1;
    }
    for (let i = count; i < 16; i += 1) this.layer.remove(`${LABEL_PREFIX}${i}`);
  }

  dispose(): void {
    this.material.dispose();
    this.slabs.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.layer?.removePrefixed(LABEL_PREFIX);
  }
}
