import { MeshDepthMaterial, type Material, type Mesh, type Object3D } from "three";

/**
 * The occluder pass only needs depth. Materials stay the ones that already place globe geometry
 * and write logarithmic depth; flipping `colorWrite` stops the unused colour attachment from
 * being filled. Shadow-map generation is postponed to the main pass so it is not drawn with
 * colour writes disabled.
 */
export function withColorWriteDisabled(roots: readonly Object3D[], draw: () => void): void {
  const saved: { material: Material; colorWrite: boolean }[] = [];
  const seen = new Set<Material>();
  for (const root of roots) {
    root.traverse((obj) => {
      const mesh = obj as Object3D & { isMesh?: boolean; material?: Material | Material[] };
      if (!mesh.isMesh || mesh.material == null) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (seen.has(material)) continue;
        seen.add(material);
        saved.push({ material, colorWrite: material.colorWrite });
        material.colorWrite = false;
      }
    });
  }
  try {
    draw();
  } finally {
    for (const item of saved) item.material.colorWrite = item.colorWrite;
  }
}

const sharedDepthMaterial = new MeshDepthMaterial();

/**
 * Occluder pass stand-in: a mesh that already has a placement-aware `customDepthMaterial`
 * (globe buildings) keeps that material; everything else uses a plain depth material.
 * The lit material is restored even if drawing throws, so the main pass is unchanged.
 */
export function withDepthStandIns(roots: readonly Object3D[], draw: () => void): void {
  const saved: { mesh: Mesh; material: Material | Material[] }[] = [];
  for (const root of roots) {
    root.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      saved.push({ mesh, material: mesh.material });
      mesh.material = mesh.customDepthMaterial ?? sharedDepthMaterial;
    });
  }
  try {
    draw();
  } finally {
    for (const item of saved) item.mesh.material = item.material;
  }
}

/** Keep the shadow pass off this draw, then restore the flag even when `draw` throws. */
export function withoutShadowPass(
  renderer: { shadowMap: { needsUpdate: boolean } },
  draw: () => void,
): void {
  const previous = renderer.shadowMap.needsUpdate;
  renderer.shadowMap.needsUpdate = false;
  try {
    draw();
  } finally {
    renderer.shadowMap.needsUpdate = previous;
  }
}
