import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

export interface BuildingsMeta {
  count: number;
  source: string;
  license: string;
  max_height_m: number;
  [key: string]: unknown;
}

/**
 * Extruded building footprints ("白膜") produced by pipeline/bldpipe.
 *
 * The glb is in root-local km with real heights; it may carry a dequantisation transform
 * from gltfpack, so we never touch the loaded nodes — vertical exaggeration comes from the
 * parent `root.scale.y`. No normals are stored: `flatShading` derives face normals from
 * screen-space derivatives, which is exactly right for prisms.
 */
export class Buildings {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  meta: BuildingsMeta | null = null;
  available = false;
  private readonly exaggeration = { value: 3 };

  constructor() {
    this.group.name = "buildings";
    this.material = new THREE.MeshStandardMaterial({
      color: 0xe9edf2,
      roughness: 0.82,
      metalness: 0.0,
      flatShading: true,
    });
    // Cheap ambient-occlusion look: darken the lowest ~25 m of every wall, plus a faint
    // cool tint towards the base so dense blocks keep their silhouettes.
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uExag = this.exaggeration;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vWorldY;")
        .replace(
          "#include <worldpos_vertex>",
          "#include <worldpos_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying float vWorldY;\nuniform float uExag;",
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float hMeters = vWorldY / max(uExag, 1e-3) * 1000.0;
          float ao = mix(0.42, 1.0, smoothstep(0.0, 28.0, hMeters));
          diffuseColor.rgb *= ao;
          diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.86, 0.9, 1.0), diffuseColor.rgb, ao);`,
        );
    };
  }

  async load(baseUrl = "/data/buildings"): Promise<boolean> {
    try {
      const response = await fetch(`${baseUrl}/buildings.json`);
      if (!response.ok) return false;
      this.meta = (await response.json()) as BuildingsMeta;
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(`${baseUrl}/buildings.glb`);
      gltf.scene.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.material = this.material;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
      });
      this.group.add(gltf.scene);
      this.available = true;
      return true;
    } catch (error) {
      console.warn("buildings unavailable", error);
      return false;
    }
  }

  setExaggeration(value: number): void {
    this.exaggeration.value = value;
  }

  setOpacity(opacity: number): void {
    this.material.opacity = opacity;
    this.material.transparent = opacity < 0.999;
    this.material.depthWrite = true;
  }

  setShadows(on: boolean): void {
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = on;
    });
  }

  dispose(): void {
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    this.material.dispose();
  }
}
