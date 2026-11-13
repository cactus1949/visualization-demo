/**
 * Depth-only stand-in for Cesium's ground inside three. Cesium's depth is not usable after its
 * frame, so each frame the overlay clears depth, draws this mesh with colorWrite off, then the
 * layers: anything below ground is hidden. Built from the same DEM as the Cesium terrain
 * (terrain on) or as a curved ellipsoid patch (terrain off). Exact float64 placement on the CPU.
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial } from "three";
import { demHeightAt, type Dem } from "../geo/geoData";
import { domainSpanM, enuFrameAt, exactEnu, type GeoGrid, type GeoMap } from "../geo/mapping";

export interface ProxyOptions {
  /** extra margin around the domain, in metres */
  marginM?: number;
  /** vertices per side */
  segments?: number;
}

export function buildDepthProxyGeometry(grid: GeoGrid, map: GeoMap, dem: Dem | null, opts: ProxyOptions = {}): BufferGeometry {
  const seg = opts.segments ?? 200;
  const frame = enuFrameAt(map.lon0, map.lat0);
  const span = domainSpanM(grid, frame);
  const mu = (opts.marginM ?? 1500) / span.east;
  const mv = (opts.marginM ?? 1500) / span.north;
  const pos = new Float32Array((seg + 1) * (seg + 1) * 3);
  let p = 0;
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const u = -mu + ((1 + 2 * mu) * i) / seg;
      const v = -mv + ((1 + 2 * mv) * j) / seg;
      const lon = grid.lon_min + u * (grid.lon_max - grid.lon_min);
      const lat = grid.lat_min + v * (grid.lat_max - grid.lat_min);
      const e = exactEnu(grid, frame, u, v, dem ? demHeightAt(dem, lon, lat) : 0);
      pos[p++] = e[0] / map.enu_unit_m;
      pos[p++] = e[1] / map.enu_unit_m;
      pos[p++] = e[2] / map.enu_unit_m;
    }
  }
  const idx = new Uint32Array(seg * seg * 6);
  let q = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.set([a, b, d, a, d, c], q);
      q += 6;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

export class DepthProxy {
  readonly mesh: Mesh;
  private readonly flat: BufferGeometry;
  private readonly terrain: BufferGeometry;

  constructor(grid: GeoGrid, map: GeoMap, dem: Dem) {
    this.flat = buildDepthProxyGeometry(grid, map, null);
    this.terrain = buildDepthProxyGeometry(grid, map, dem);
    this.mesh = new Mesh(this.flat, new MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: DoubleSide }));
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
  }

  setTerrain(on: boolean): void {
    this.mesh.geometry = on ? this.terrain : this.flat;
  }

  dispose(): void {
    this.flat.dispose();
    this.terrain.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
  }
}
