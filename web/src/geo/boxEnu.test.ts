import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enuFrameAt, exactEnu, gridToLonLat, polyInverse, type EnuFrame, type GeoGrid, type GeoMap, type Vec3 } from "./mapping.ts";
import { ellipsoidHeight, sampleGrid, type GridField } from "./placement.ts";

// Local copies of geo/boxEnu.ts (that file is imported by the app without .ts suffixes,
// which node --test cannot resolve). Keep these in sync with boxEnu.ts.
function boxToUv(sx: number, sz: number, x: number, z: number): { u: number; v: number } {
  return { u: x / sx + 0.5, v: 0.5 - z / sz };
}
function uvToBox(sx: number, sz: number, u: number, v: number): { x: number; z: number } {
  return { x: (u - 0.5) * sx, z: (0.5 - v) * sz };
}
function frameOf(map: GeoMap): EnuFrame {
  return enuFrameAt(map.lon0, map.lat0);
}
function placeEnuUnits(grid: GeoGrid, map: GeoMap, frame: EnuFrame, u: number, v: number, aglM: number, k: number, ground: GridField | null): Vec3 {
  const g = ground ? sampleGrid(ground, u, v) : 0;
  const e = exactEnu(grid, frame, u, v, ellipsoidHeight(g, k, aglM));
  const s = map.enu_unit_m;
  return [e[0] / s, e[1] / s, e[2] / s];
}
function enuUnitsToUvAgl(map: GeoMap, enu: Vec3, k: number, ground: GridField | null): { u: number; v: number; h: number; agl: number } {
  const s = map.enu_unit_m;
  const inv = polyInverse(map, [enu[0] * s, enu[1] * s, enu[2] * s]);
  const g = ground ? sampleGrid(ground, inv.u, inv.v) : 0;
  return { u: inv.u, v: inv.v, h: inv.h, agl: (inv.h - g) / Math.max(k, 1e-9) };
}
function cellToUv(nx: number, ny: number, ix: number, iy: number): { u: number; v: number } {
  return { u: ix / Math.max(1, nx - 1), v: iy / Math.max(1, ny - 1) };
}
function uvToCell(nx: number, ny: number, u: number, v: number): { ix: number; iy: number } {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  return { ix: Math.round(clamp(u * (nx - 1), 0, nx - 1)), iy: Math.round(clamp(v * (ny - 1), 0, ny - 1)) };
}

const { grid, map } = JSON.parse(readFileSync(new URL("./testdata/tianjin-map.json", import.meta.url), "utf8"));
const frame = frameOf(map);
const nx = 300, ny = 300;
const ground = {
  nx,
  ny,
  values: new Float32Array(nx * ny).map((_, i) => -2.5 + 12.5 * Math.sin((i % nx) / 7) * Math.cos(Math.floor(i / nx) / 5)),
};

describe("box <-> uv", () => {
  it("round-trips the domain corners and centre", () => {
    const sx = 20, sz = 30;
    for (const [x, z] of [[-10, 15], [10, -15], [0, 0], [4, -7]] as const) {
      const { u, v } = boxToUv(sx, sz, x, z);
      const b = uvToBox(sx, sz, u, v);
      assert.ok(Math.abs(b.x - x) < 1e-12 && Math.abs(b.z - z) < 1e-12);
    }
  });
  it("cell 0,0 is the south-west corner (u=0, v=0)", () => {
    assert.deepEqual(cellToUv(301, 301, 0, 0), { u: 0, v: 0 });
    assert.deepEqual(uvToCell(301, 301, 0, 0), { ix: 0, iy: 0 });
    assert.deepEqual(uvToCell(301, 301, 1, 1), { ix: 300, iy: 300 });
  });
});

describe("exact ENU placement and inverse polynomial", () => {
  it("placeEnuUnits matches exactEnu / enu_unit_m at AGL with terrain and k", () => {
    const u = 0.25, v = 0.8, agl = 250, k = 3;
    const p = placeEnuUnits(grid, map, frame, u, v, agl, k, ground);
    const g = sampleGrid(ground, u, v);
    const e = exactEnu(grid, frame, u, v, g + k * agl);
    const s = map.enu_unit_m;
    assert.ok(Math.hypot(p[0] - e[0] / s, p[1] - e[1] / s, p[2] - e[2] / s) * s < 1e-9);
  });
  it("inverse polynomial residual at a placed point is millimetre-scale", () => {
    const cases: [number, number, number, number, boolean][] = [
      [0.5, 0.5, 0, 1, false],
      [0.1, 0.2, 500, 1, true],
      [0.9, 0.85, 1000, 10, true],
      [0, 0, 250, 3, false],
    ];
    for (const [u, v, agl, k, terrain] of cases) {
      const g = terrain ? ground : null;
      const p = placeEnuUnits(grid, map, frame, u, v, agl, k, g);
      const inv = enuUnitsToUvAgl(map, p, k, g);
      const q = placeEnuUnits(grid, map, frame, inv.u, inv.v, inv.agl, k, g);
      const resM = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * map.enu_unit_m * 1000;
      assert.ok(resM < 8, `residual ${resM} mm at u=${u} v=${v} agl=${agl} k=${k}`);
      assert.ok(Math.abs(inv.agl - agl) < 0.05, `agl ${inv.agl} vs ${agl}`);
    }
  });
});
