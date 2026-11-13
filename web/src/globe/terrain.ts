/**
 * Terrain switch: smooth WGS84 ellipsoid, or the self-built DEM (already ellipsoidal heights)
 * through Cesium's public CustomHeightmapTerrainProvider. Both providers are built once, so
 * toggling only swaps `viewer.terrainProvider`; no data is fetched again.
 */
import { CustomHeightmapTerrainProvider, EllipsoidTerrainProvider, GeographicTilingScheme, Math as CMath, type TerrainProvider } from "cesium";
import { demHeightAt, type Dem } from "../geo/geoData";

const TILE = 33;

export function demTerrainProvider(dem: Dem): CustomHeightmapTerrainProvider {
  const scheme = new GeographicTilingScheme();
  return new CustomHeightmapTerrainProvider({
    width: TILE,
    height: TILE,
    tilingScheme: scheme,
    callback(x, y, level) {
      const r = scheme.tileXYToRectangle(x, y, level);
      const out = new Float32Array(TILE * TILE);
      for (let j = 0; j < TILE; j++) {
        const lat = CMath.toDegrees(r.north - ((r.north - r.south) * j) / (TILE - 1));
        for (let i = 0; i < TILE; i++) out[j * TILE + i] = demHeightAt(dem, CMath.toDegrees(r.west + ((r.east - r.west) * i) / (TILE - 1)), lat);
      }
      return out;
    },
  });
}

export interface TerrainSwitch {
  provider(on: boolean): TerrainProvider;
}

export function terrainSwitch(dem: Dem): TerrainSwitch {
  const flat = new EllipsoidTerrainProvider();
  const real = demTerrainProvider(dem);
  return { provider: (on) => (on ? real : flat) };
}
