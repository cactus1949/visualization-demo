import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { geoPlaceGlsl, type GeoUniforms } from "../globe/geoShader";
import type { GeoMap } from "../geo/mapping";

/**
 * Box km → (u, v, AGL m) → curved-shell ENU, then the usual view/projection. Shared by the
 * colour material and the shadow depth material so casters and receivers sit in one place.
 * Leaves `boxKm`, `uvAgl`, `enu`, `mvPosition` in scope for later chunks.
 */
const GLOBE_PLACE_GLSL = `vec3 boxKm = (modelMatrix * vec4(transformed, 1.0)).xyz;
vec3 uvAgl = vec3(boxKm.x / max(uFieldDomain.x, 1e-3) + 0.5, 0.5 - boxKm.z / max(uFieldDomain.y, 1e-3), boxKm.y * 1000.0);
vec3 enu = geoPlace(uvAgl);
vec4 mvPosition = viewMatrix * vec4(enu, 1.0);
gl_Position = projectionMatrix * mvPosition;`;

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
  private readonly tint = {
    texture: null as THREE.Texture | null,
    domain: new THREE.Vector2(1, 1),
    enabled: 0,
    strength: 0.6,
  };
  private tintUniforms: {
    uFieldTexture: { value: THREE.Texture | null };
    uFieldDomain: { value: THREE.Vector2 };
    uTintEnabled: { value: number };
    uTintStrength: { value: number };
  } | null = null;
  private shadows = true;
  private globe: { map: GeoMap; geo: GeoUniforms } | null = null;
  /** One uniform object for the colour and depth materials, so setTint reaches both. */
  private readonly fieldDomain = { value: this.tint.domain };
  /**
   * Globe only: the built-in shadow depth material would render the box-km mesh as if it
   * were ENU (1 unit = 10 km), so casters get the same placement as the colour pass.
   */
  private depthMaterial: THREE.MeshDepthMaterial | null = null;

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
      const globe = this.globe;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          globe
            ? `#include <common>
varying float vWorldY;
varying vec2 vFieldUv;
uniform vec2 uFieldDomain;
${geoPlaceGlsl(globe.map)}`
            : "#include <common>\nvarying float vWorldY;\nvarying vec2 vFieldUv;\nuniform vec2 uFieldDomain;",
        )
        .replace(
          "#include <project_vertex>",
          globe
            ? `${GLOBE_PLACE_GLSL}
vWorldY = boxKm.y;
vFieldUv = uvAgl.xy;`
            : "#include <project_vertex>",
        )
        .replace(
          "#include <worldpos_vertex>",
          globe
            ? `#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4(enu, 1.0);
#endif`
            : "#include <worldpos_vertex>\nvec3 rootPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWorldY = rootPosition.y;\nvFieldUv = vec2(rootPosition.x / max(uFieldDomain.x, 1e-3) + 0.5, 0.5 - rootPosition.z / max(uFieldDomain.y, 1e-3));",
        );
      if (globe) Object.assign(shader.uniforms, globe.geo);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying float vWorldY;\nvarying vec2 vFieldUv;\nuniform float uExag;\nuniform sampler2D uFieldTexture;\nuniform float uTintEnabled;\nuniform float uTintStrength;",
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          if (uTintEnabled > 0.5 && uTintStrength > 0.0) {
            // LOD 0: mip levels average colours of masked-out cells with in-window ones,
            // which tinted towers outside the ground value window pink.
            vec4 fieldSample = textureLod(uFieldTexture, clamp(vFieldUv, 0.0, 1.0), 0.0);
            // Custom sampler2D is not auto-decoded; r187 GLSL helper is sRGBTransferEOTF (vec4).
            vec3 fieldColor = mix(pow(fieldSample.rgb * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), fieldSample.rgb * 0.0773993808, vec3(lessThanEqual(fieldSample.rgb, vec3(0.04045))));
            diffuseColor.rgb = mix(diffuseColor.rgb, fieldColor, clamp(uTintStrength, 0.0, 1.0) * fieldSample.a);
          }
          float hMeters = vWorldY / max(uExag, 1e-3) * 1000.0;
          float ao = mix(0.42, 1.0, smoothstep(0.0, 28.0, hMeters));
          diffuseColor.rgb *= ao;
          diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.86, 0.9, 1.0), diffuseColor.rgb, ao);`,
        );
      shader.uniforms.uFieldTexture = { value: this.tint.texture };
      shader.uniforms.uFieldDomain = this.fieldDomain;
      shader.uniforms.uTintEnabled = { value: this.tint.enabled };
      shader.uniforms.uTintStrength = { value: this.tint.strength };
      this.tintUniforms = {
        uFieldTexture: shader.uniforms.uFieldTexture,
        uFieldDomain: shader.uniforms.uFieldDomain,
        uTintEnabled: shader.uniforms.uTintEnabled,
        uTintStrength: shader.uniforms.uTintStrength,
      };
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
        if (this.depthMaterial) mesh.customDepthMaterial = this.depthMaterial;
      });
      this.group.add(gltf.scene);
      this.available = true;
      return true;
    } catch (error) {
      console.warn("buildings unavailable", error);
      return false;
    }
  }

  /**
   * Place the box-km mesh onto the curved shell in the vertex shader:
   * (x, z) → (u, v), y km → AGL metres, then h = g + k * AGL.
   * Call before the material is compiled (before the first render with this mesh).
   */
  enableGlobe(map: GeoMap, geo: GeoUniforms): void {
    this.globe = { map, geo };
    this.material.needsUpdate = true;
    if (!this.depthMaterial) {
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      depth.onBeforeCompile = (shader) => {
        const g = this.globe!;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", `#include <common>\nuniform vec2 uFieldDomain;\n${geoPlaceGlsl(g.map)}`)
          .replace("#include <project_vertex>", GLOBE_PLACE_GLSL);
        Object.assign(shader.uniforms, g.geo);
        shader.uniforms.uFieldDomain = this.fieldDomain;
      };
      depth.customProgramCacheKey = () => "buildings-globe-depth";
      this.depthMaterial = depth;
    }
    this.depthMaterial.needsUpdate = true;
    // enableGlobe may run after load(): attach to meshes already in the group.
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) mesh.customDepthMaterial = this.depthMaterial!;
    });
  }

  setExaggeration(value: number): void {
    this.exaggeration.value = value;
  }

  setOpacity(opacity: number): void {
    const value = THREE.MathUtils.clamp(Number(opacity) || 0, 0, 1);
    this.material.opacity = value;
    // Hashed alpha keeps depth testing/writing stable for a very large mesh and avoids
    // the sorting artifacts of blended transparency.
    this.material.alphaHash = value < 0.999;
    this.material.transparent = false;
    this.material.depthWrite = true;
    this.material.needsUpdate = true;
    this.updateShadowFlags();
  }

  setTint(
    texture: THREE.Texture | null,
    domain: { sx: number; sz: number },
    enabled: boolean,
    strength: number,
  ): void {
    this.tint.texture = texture;
    this.tint.domain.set(domain.sx, domain.sz);
    this.tint.enabled = enabled && texture !== null ? 1 : 0;
    this.tint.strength = THREE.MathUtils.clamp(strength, 0, 1);
    if (this.tintUniforms) {
      this.tintUniforms.uFieldTexture.value = texture;
      this.tintUniforms.uFieldDomain.value = this.tint.domain;
      this.tintUniforms.uTintEnabled.value = this.tint.enabled;
      this.tintUniforms.uTintStrength.value = this.tint.strength;
    }
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    this.updateShadowFlags();
  }

  private updateShadowFlags(): void {
    const on = this.shadows && this.material.opacity >= 0.999;
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
    this.depthMaterial?.dispose();
  }
}
