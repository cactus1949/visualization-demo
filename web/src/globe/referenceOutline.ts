/**
 * Cyan domain edges drawn by Cesium itself from exact (lon, lat, ellipsoid height) positions:
 * the reference the three.js test layer must sit on. Same sample points and the same
 * h = g + k * AGL rule (g from the per-column ground grid when terrain is on).
 */
import { ArcType, Cartesian3, Color, Material, PolylineCollection } from "cesium";
import { gridToLonLat, type GeoGrid } from "../geo/mapping";
import { ellipsoidHeight, sampleGrid, type GridField } from "../geo/placement";
import { edgeSegments, type UvAgl } from "./testGeometry";

export function exactCartesian(grid: GeoGrid, ground: GridField | null, k: number, [u, v, agl]: UvAgl): Cartesian3 {
  const [lon, lat] = gridToLonLat(grid, u, v);
  return Cartesian3.fromDegrees(lon, lat, ellipsoidHeight(ground ? sampleGrid(ground, u, v) : 0, k, agl));
}

export function buildReferenceOutline(collection: PolylineCollection, grid: GeoGrid, ground: GridField | null, k: number): void {
  collection.removeAll();
  // one Material per polyline: removeAll() destroys each polyline's material
  for (const line of edgeSegments(grid.top_m)) {
    collection.add({ positions: line.map((p) => exactCartesian(grid, ground, k, p)), width: 3, material: Material.fromType("Color", { color: Color.CYAN }), arcType: ArcType.NONE } as never);
  }
}
