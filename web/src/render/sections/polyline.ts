import * as THREE from "three";
import { SliceMaterial } from "../slices";
import type { Domain } from "../fields";

export const MAX_POLYLINE_POINTS = 16;

export class PolylineSection {
  readonly group = new THREE.Group();
  readonly material: SliceMaterial;
  readonly mesh: THREE.Mesh;
  readonly markers = new THREE.Group();
  points: { x: number; z: number }[] = [];
  private geometry = new THREE.BufferGeometry();
  private readonly domain: Domain;

  constructor(domain: Domain) {
    this.domain = domain;
    this.material = new SliceMaterial(domain);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.userData.pickable = "polyline";
    this.group.add(this.mesh, this.markers);
    this.group.name = "polyline-section";
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
    this.markers.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.markers.clear();
    for (const p of this.points) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0x7cf3ff, transparent: true, opacity: 0.95 }),
      );
      marker.position.set(p.x, 0.08, p.z);
      marker.userData.pickable = "polyline-vertex";
      this.markers.add(marker);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.markers.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
