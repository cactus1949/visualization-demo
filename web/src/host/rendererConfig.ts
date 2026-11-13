import * as THREE from "three";

/** Appearance shared by the two layer renderers. Keep shadow setup host-specific. */
export function applyLayerRendererConfig(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  // Shadow-map policy belongs to each host. The three host enables its existing PCF path;
  // the Cesium host intentionally leaves shadows disabled until the building layer is mapped.
}
