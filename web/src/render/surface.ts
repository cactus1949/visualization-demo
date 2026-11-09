import * as THREE from "three";
import type { Manifest, VariableMeta } from "../data/manifest";
import { colorMap } from "./colormaps";
import { worldSize } from "./coords";

export function makeSurface(
  manifest: Manifest,
  meta: VariableMeta,
  data: Uint8Array,
  exaggeration: number,
): THREE.Mesh {
  const size = worldSize(manifest, exaggeration);
  const rgb = new Uint8Array(data.length * 4);
  for (let index = 0; index < data.length; index += 1) {
    const physical = meta.offset + (data[index] / 255) * (meta.range[1] - meta.range[0]);
    const normalized = (physical - meta.range[0]) / (meta.range[1] - meta.range[0]);
    const color = colorMap(meta.colormap, normalized);
    rgb[index * 4] = Math.round(color.r * 255);
    rgb[index * 4 + 1] = Math.round(color.g * 255);
    rgb[index * 4 + 2] = Math.round(color.b * 255);
    rgb[index * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(rgb, manifest.grid.nx, manifest.grid.ny, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.92,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.z), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.01;
  mesh.renderOrder = 0;
  mesh.userData.texture = texture;
  return mesh;
}

export function disposeSurface(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  const material = mesh.material as THREE.MeshBasicMaterial;
  material.map?.dispose();
  material.dispose();
}
