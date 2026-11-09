import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { texture3D, texture, uv, vec2, vec3 } from "three/tsl";
import type { Manifest, VariableMeta } from "../data/manifest";
import { colorTexture } from "./colormaps";
import { worldSize } from "./coords";

function scalarTexture(manifest: Manifest, data: Uint8Array): THREE.Data3DTexture {
  const texture3d = new THREE.Data3DTexture(
    data,
    manifest.grid.nx,
    manifest.grid.ny,
    manifest.grid.nz,
  );
  texture3d.format = THREE.RedFormat;
  texture3d.type = THREE.UnsignedByteType;
  texture3d.minFilter = THREE.LinearFilter;
  texture3d.magFilter = THREE.LinearFilter;
  texture3d.unpackAlignment = 1;
  texture3d.needsUpdate = true;
  return texture3d;
}

function materialFor(texture3d: THREE.Data3DTexture, meta: VariableMeta, depth: any): any {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
  });
  // texel is 0..1 in the shader; the physical value is texel * 255 * scale + offset.
  // With the fixed per-variable range used for quantization the texel already is the
  // normalized colormap coordinate, but we go through physical units so a window could be added.
  const texel = texture3D(texture3d, depth, 0).r;
  const physical = texel.mul(meta.scale * 255).add(meta.offset);
  const normalized = physical
    .sub(meta.range[0])
    .div(meta.range[1] - meta.range[0])
    .clamp(0, 1);
  material.colorNode = texture(colorTexture(meta.colormap), vec2(normalized, 0.5));
  return material;
}

export function makeSlice(
  manifest: Manifest,
  meta: VariableMeta,
  data: Uint8Array,
  exaggeration: number,
  level: number,
): THREE.Mesh {
  const size = worldSize(manifest, exaggeration);
  const texture3d = scalarTexture(manifest, data);
  const levelUv = (level + 0.5) / manifest.grid.nz;
  const material = materialFor(texture3d, meta, vec3(uv().x, uv().y, levelUv));
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.z), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = (manifest.grid.levels_m[level] / 1000) * exaggeration;
  mesh.renderOrder = 2;
  mesh.userData.texture = texture3d;
  return mesh;
}

export function makeCross(
  manifest: Manifest,
  meta: VariableMeta,
  data: Uint8Array,
  exaggeration: number,
  axis: "x" | "z",
  fraction: number,
): THREE.Mesh {
  const size = worldSize(manifest, exaggeration);
  const texture3d = scalarTexture(manifest, data);
  const u = uv();
  const depth = axis === "x" ? vec3(u.x, fraction, u.y) : vec3(fraction, u.x, u.y);
  const material = materialFor(texture3d, meta, depth);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(axis === "x" ? size.x : size.z, size.y),
    material,
  );
  mesh.position.y = size.y / 2;
  if (axis === "x") mesh.position.z = (0.5 - fraction) * size.z;
  else {
    mesh.position.x = (fraction - 0.5) * size.x;
    mesh.rotation.y = Math.PI / 2;
  }
  mesh.renderOrder = 2;
  mesh.userData.texture = texture3d;
  return mesh;
}
