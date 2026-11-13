import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Cartesian3, Matrix4, Transforms } from "cesium";
import { domainSpanM, enuFrameAt, exactEnu, gridToLonLat, polyForward, polyInverse, type Vec3 } from "./mapping.ts";

// grid + map section of geo.json for the Tianjin corners (pipeline test keeps it in sync with geopipe)
const fixture = JSON.parse(readFileSync(new URL("./testdata/tianjin-map.json", import.meta.url), "utf8"));
const { grid, map } = fixture;
const frame = enuFrameAt(map.lon0, map.lat0);
const cesiumEcefToEnu = Matrix4.inverseTransformation(
  Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(map.lon0, map.lat0, 0)),
  new Matrix4(),
);
const span = domainSpanM(grid, frame);

/** Cesium's own placement of grid point (u, v) at ellipsoid height h, in centre-ENU metres. */
function cesiumEnu(u: number, v: number, h: number): Vec3 {
  const [lon, lat] = gridToLonLat(grid, u, v);
  const p = Matrix4.multiplyByPoint(cesiumEcefToEnu, Cartesian3.fromDegrees(lon, lat, h), new Cartesian3());
  return [p.x, p.y, p.z];
}

function samples(n: number): Vec3[] {
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: n }, (): Vec3 => [rnd(), rnd(), map.h_valid_m[0] + rnd() * (map.h_valid_m[1] - map.h_valid_m[0])]);
}
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const POINTS = samples(20000);
const mm = (m: number) => `${(m * 1000).toPrecision(3)} mm`;

describe("grid <-> centre-ENU mapping vs Cesium Cartesian3.fromDegrees (20 000 points, h -100..10100 m)", () => {
  it("exact path agrees with Cesium to well under a millimetre", () => {
    const max = Math.max(...POINTS.map(([u, v, h]) => dist(exactEnu(grid, frame, u, v, h), cesiumEnu(u, v, h))));
    console.log(`exact vs Cesium max ${mm(max)}`);
    assert.ok(max < 1e-4, mm(max));
  });

  it("forward polynomial stays within 0.1 mm (float64) and 6 mm (float32, as in shaders)", () => {
    let f64 = 0, f32 = 0;
    for (const [u, v, h] of POINTS) {
      const ref = cesiumEnu(u, v, h);
      f64 = Math.max(f64, dist(polyForward(map, u, v, h), ref));
      f32 = Math.max(f32, dist(polyForward(map, u, v, h, Math.fround), ref));
    }
    console.log(`forward max: f64 ${mm(f64)}, f32 ${mm(f32)}`);
    assert.ok(f64 < 1e-4, mm(f64));
    assert.ok(f32 < 6e-3, mm(f32));
  });

  it("inverse polynomial recovers (u, v, h) within 6 mm (float64) and 8 mm (float32)", () => {
    let f64 = 0, f32 = 0;
    const err = (r: { u: number; v: number; h: number }, u: number, v: number, h: number) =>
      Math.hypot((r.u - u) * span.east, (r.v - v) * span.north, r.h - h);
    for (const [u, v, h] of POINTS) {
      const enu = cesiumEnu(u, v, h);
      f64 = Math.max(f64, err(polyInverse(map, enu), u, v, h));
      f32 = Math.max(f32, err(polyInverse(map, enu, Math.fround), u, v, h));
    }
    console.log(`inverse max: f64 ${mm(f64)}, f32 ${mm(f32)}`);
    assert.ok(f64 < 6e-3, mm(f64));
    assert.ok(f32 < 8e-3, mm(f32));
  });

  it("grid edges sit where the nc corner lon/lat put them, not where dx_m = 60 m would", () => {
    const s = polyForward(map, 0.5, 0, 0), n = polyForward(map, 0.5, 1, 0);
    const north = Math.hypot(n[0] - s[0], n[1] - s[1]);
    assert.ok(Math.abs(north - span.north) < 0.01, `${north} vs ${span.north}`);
    // nc lat step is 60 m / 110574 m per degree, so the true extent is ~60.24 m x 299, not 17 940 m
    assert.ok(north > 18000 && north < 18030, String(north));
  });
});
