import * as THREE from "three";
import { SliceMaterial } from "../slices";
import type { Domain } from "../fields";
import type { AnnotationLayer } from "../annotations";
import { gridQuad, segmentsFor, type SectionGlobe } from "./globe";

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

  private readonly globe: SectionGlobe | null;

  constructor(domain: Domain, globe: SectionGlobe | null = null) {
    this.domain = domain;
    this.globe = globe;
    this.material = new SliceMaterial(domain, globe);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    // globe: box-km geometry, CPU raycasts would hit the wrong place (vertices are dragged by handle)
    if (globe) this.mesh.raycast = () => {};
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
    if (this.globe) {
      this.rebuildGlobe();
      return;
    }
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

  /** Globe: every wall segment subdivided along its length so it follows the curved shell. */
  private rebuildGlobe(): void {
    const n = this.points.length;
    const top = this.domain.top;
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n - 1; i += 1) {
      const a = this.points[i]!, b = this.points[i + 1]!;
      parts.push(gridQuad(
        new THREE.Vector3(a.x, 0, a.z), new THREE.Vector3(b.x, 0, b.z),
        new THREE.Vector3(b.x, top, b.z), new THREE.Vector3(a.x, top, a.z),
        segmentsFor(Math.hypot(b.x - a.x, b.z - a.z)), 4,
      ));
    }
    const count = parts.reduce((m, g) => m + g.getAttribute("position").count, 0);
    const pos = new Float32Array(count * 3);
    const idx: number[] = [];
    let base = 0;
    for (const g of parts) {
      pos.set(g.getAttribute("position").array as Float32Array, base * 3);
      for (const k of g.getIndex()!.array) idx.push(k + base);
      base += g.getAttribute("position").count;
      g.dispose();
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
    // A single vertex must still show its handle; the wall itself needs ≥2 points.
    const visible = this.points.length >= 1;
    this.points.forEach((p, i) => {
      const id = `${HANDLE_PREFIX}${i}`;
      this.layer!.addHandle(id, {
        anchor: { x: p.x, y: 0, z: p.z },
        space: "box",
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

  clearHandles(): void {
    this.layer?.removePrefixed(HANDLE_PREFIX);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.layer?.removePrefixed(HANDLE_PREFIX);
  }
}
