import * as THREE from "three";

/** Appearance shared by the two layer renderers, including the single shadow-map path. */
export function applyLayerRendererConfig(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  // One PCF shadow path for both hosts (⑥ adds building shadows here; do not open a second path).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Draw the shadow map once per frame. Each host calls beginLayerFrame() at the top of its
  // frame; the first render that has a shadow-casting light (the occluder-depth capture or the
  // main pass) draws it, later renders in the same frame reuse it.
  renderer.shadowMap.autoUpdate = false;
}

/** Start of a host frame: let the next render with shadow-casting lights redraw the shadow map. */
export function beginLayerFrame(renderer: THREE.WebGLRenderer): void {
  renderer.shadowMap.needsUpdate = true;
}
