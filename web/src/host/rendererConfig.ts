import * as THREE from "three";

/** Appearance shared by the two layer renderers, including the single shadow-map path. */
export function applyLayerRendererConfig(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  // One PCF shadow path for both hosts (⑥ adds building shadows here; do not open a second path).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
}
