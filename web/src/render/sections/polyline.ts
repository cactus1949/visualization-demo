import * as THREE from "three";
import { SliceMaterial } from "../slices";
import type { Domain } from "../fields";
import type { AnnotationLayer } from "../annotations";

export const MAX_POLYLINE_POINTS = 16;
const HANDLE_PREFIX = "polyline-v-";

export class PolylineSection {
  readonly group = new THREE.Group();
  readonly material: SliceMaterial;
  readonly mesh: THREE.Mesh;
  points: { x: number; z: number }[] = [];
  private geometry = new THREE.BufferGeometry();
  private readonly domain: Domain;
  private layer: AnnotationLayer | null = null;
  private selected = -1;

  constructor(domain: Domain) {
    this.domain = domain;
    this.material = new SliceMaterial(domain);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.userData.pickable = "polyline";
    this.group.add(this.mesh);
    this.group.name = "polyline-section";
  }

  setAnnotationLayer(layer: AnnotationLayer | null): void {
    this.layer = layer;
    this.syncHandles();
  }

  setSelected(index: number): void {
    this.selected = index;
    this.syncHandleStates();
  }

  setPoints(points: { x: number; z: number }[]): void {
    this.points = points.slice(0, MAX_POLYLINE_POINTS).map((p) => ({
      x: THREE.MathUtils.clamp(p.x, -this.domain.sx / 2, this.domain.sx / 2),
      z: THREE.MathUtils.clamp(p.z, -this.domain.sz / 2, this.domain.sz / 2),
    }));
    this.rebuild();
  }

  private rebuild(): void {
    const n = this.points.length;
    const top = this.domain.top;
    const pos = new Float32Array(Math.max(0, n - 1) * 12);
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i += 1) {
      const a = this.points[i], b = this.points[i + 1];
      const o = i * 4;
      pos.set([a.x, 0, a.z, b.x, 0, b.z, b.x, top, b.z, a.x, top, a.z], i * 12);
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geometry.setIndex(idx);
    this.mesh.geometry = this.geometry;
    this.group.visible = n >= 2;
    this.syncHandles();
  }

  private syncHandles(): void {
    if (!this.layer) return;
    const visible = this.group.visible;
    this.points.forEach((p, i) => {
      const id = `${HANDLE_PREFIX}${i}`;
      this.layer!.addHandle(id, {
        anchor: { x: p.x, y: 0, z: p.z },
        role: "preview",
        draggable: true,
        visible,
        state: i === this.selected ? "selected" : "idle",
        userData: { pickable: "polyline-vertex", index: i },
      });
    });
    for (let i = this.points.length; i < MAX_POLYLINE_POINTS; i += 1) {
      this.layer.remove(`${HANDLE_PREFIX}${i}`);
    }
  }

  syncAnnotations(): void {
    this.syncHandles();
  }

  private syncHandleStates(): void {
    if (!this.layer) return;
    this.points.forEach((_, i) => {
      this.layer!.setState(`${HANDLE_PREFIX}${i}`, i === this.selected ? "selected" : "idle");
    });
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.layer?.removePrefixed(HANDLE_PREFIX);
  }
}
