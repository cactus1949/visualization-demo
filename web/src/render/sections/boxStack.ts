import * as THREE from "three";
import { SliceMaterial } from "../slices";
import type { Domain } from "../fields";

export interface BoxStackParams {
  x0: number; z0: number; x1: number; z1: number;
  levels: number[]; heightMinM: number; heightMaxM: number;
  stepLevels: number; stretch: number; spacingKm: number;
}

function labelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(5,15,25,.8)"; ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = "#dff8ff"; ctx.font = "28px sans-serif"; ctx.fillText(text, 8, 42);
  const tex = new THREE.CanvasTexture(canvas);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(1.3, 0.33, 1);
  return s;
}

export class BoxStack {
  readonly group = new THREE.Group();
  readonly slabs = new THREE.Group();
  readonly labels = new THREE.Group();
  readonly domain: Domain;
  readonly material: SliceMaterial;
  params: BoxStackParams;
  constructor(domain: Domain, levels: number[]) {
    this.domain = domain;
    this.material = new SliceMaterial(domain);
    this.params = { x0: -2, z0: -2, x1: 2, z1: 2, levels, heightMinM: 100, heightMaxM: 300, stepLevels: 5, stretch: 1, spacingKm: 0 };
    this.group.add(this.slabs, this.labels);
    this.group.name = "box-stack";
    this.update(this.params);
  }
  update(p: BoxStackParams): void {
    this.params = { ...p, stepLevels: Math.max(1, Math.round(p.stepLevels || 1)) };
    this.slabs.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.labels.traverse((o) => { if (o instanceof THREE.Sprite) { (o.material as THREE.SpriteMaterial).map?.dispose(); (o.material as THREE.Material).dispose(); } });
    this.slabs.clear(); this.labels.clear();
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
      const s = labelSprite(`${h.toFixed(1)} m`);
      s.position.set(this.params.x0, y + 0.08, this.params.z0);
      this.labels.add(s); count += 1;
    }
    this.group.visible = count > 0;
  }
  updateLabels(camera: THREE.Camera): void { this.labels.traverse((o) => { if (o instanceof THREE.Sprite) o.quaternion.copy(camera.quaternion); }); }
  dispose(): void {
    this.material.dispose();
    this.slabs.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.labels.traverse((o) => { if (o instanceof THREE.Sprite) { (o.material as THREE.SpriteMaterial).map?.dispose(); (o.material as THREE.Material).dispose(); } });
  }
}
