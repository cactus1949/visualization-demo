/**
 * Domain ground on the globe: a curved shell (ellipsoid or DEM) with the same 2D field
 * texture the box tabs paint on the flat floor. Geometry is exact float64 CPU placement
 * so picking is in real lon/lat; terrain on/off swaps a prebuilt mesh and does not
 * reload volume data. k does not move the ground (AGL = 0).
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShadowMaterial,
  type Texture,
} from "three";
import { demHeightAt, type Dem } from "../geo/geoData";
import { enuFrameAt, exactEnu, type GeoGrid, type GeoMap } from "../geo/mapping";

const LIFT_M = 0.75;

export function buildGlobeGroundGeometry(
  grid: GeoGrid,
  map: GeoMap,
  dem: Dem | null,
  segments = 200,
): BufferGeometry {
  const frame = enuFrameAt(map.lon0, map.lat0);
  const s = map.enu_unit_m;
  const pos = new Float32Array((segments + 1) * (segments + 1) * 3);
  const uv = new Float32Array((segments + 1) * (segments + 1) * 2);
  let p = 0, t = 0;
  for (let j = 0; j <= segments; j++) {
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const v = j / segments;
      const lon = grid.lon_min + u * (grid.lon_max - grid.lon_min);
      const lat = grid.lat_min + v * (grid.lat_max - grid.lat_min);
      const h = (dem ? demHeightAt(dem, lon, lat) : 0) + LIFT_M;
      const e = exactEnu(grid, frame, u, v, h);
      pos[p++] = e[0] / s;
      pos[p++] = e[1] / s;
      pos[p++] = e[2] / s;
      // v = 0 is south, matching the box floor texture (row 0 = southernmost).
      uv[t++] = u;
      uv[t++] = v;
    }
  }
  const idx = new Uint32Array(segments * segments * 6);
  let q = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * (segments + 1) + i, b = a + 1, c = a + segments + 1, d = c + 1;
      idx.set([a, b, d, a, d, c], q);
      q += 6;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("uv", new BufferAttribute(uv, 2));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export class GlobeGround {
  readonly mesh: Mesh;
  private readonly flat: BufferGeometry;
  private readonly terrain: BufferGeometry;
  private readonly fieldMaterial: MeshStandardMaterial;
  private readonly shadowMaterial: ShadowMaterial;
  private readonly pickMaterial: MeshBasicMaterial;
  private fieldOn = false;
  private shadowsOn = false;
  private hasMap = false;

  constructor(grid: GeoGrid, map: GeoMap, dem: Dem) {
    this.flat = buildGlobeGroundGeometry(grid, map, null);
    this.terrain = buildGlobeGroundGeometry(grid, map, dem);
    this.fieldMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      side: DoubleSide,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.shadowMaterial = new ShadowMaterial({
      color: 0x000000,
      opacity: 0.32,
      side: DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.pickMaterial = new MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
    });
    this.mesh = new Mesh(this.flat, this.pickMaterial);
    this.mesh.name = "globe-ground";
    this.mesh.userData.pickable = "ground";
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.applyMaterial();
  }

  setTerrain(on: boolean): void {
    this.mesh.geometry = on ? this.terrain : this.flat;
  }

  /** Show the 2D field (or hide it). The mesh stays pickable either way. */
  setField(on: boolean, map: Texture | null): void {
    this.fieldOn = on && map !== null;
    this.hasMap = map !== null;
    if (this.fieldMaterial.map !== map) {
      this.fieldMaterial.map = map;
      this.fieldMaterial.needsUpdate = true;
    }
    this.applyMaterial();
  }

  setShadows(on: boolean): void {
    this.shadowsOn = on;
    this.mesh.receiveShadow = on;
    this.applyMaterial();
  }

  private applyMaterial(): void {
    if (this.fieldOn && this.hasMap) this.mesh.material = this.fieldMaterial;
    else if (this.shadowsOn) this.mesh.material = this.shadowMaterial;
    else this.mesh.material = this.pickMaterial;
    this.mesh.visible = true;
  }

  dispose(): void {
    this.flat.dispose();
    this.terrain.dispose();
    this.fieldMaterial.dispose();
    this.shadowMaterial.dispose();
    this.pickMaterial.dispose();
  }
}
