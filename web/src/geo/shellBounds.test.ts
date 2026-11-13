import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enuFrameAt, exactEnu, shellBounds } from "./mapping.ts";
import { groundSampler } from "./placement.ts";

const { grid, map } = JSON.parse(readFileSync(new URL("./testdata/tianjin-map.json", import.meta.url), "utf8"));
const frame = enuFrameAt(map.lon0, map.lat0);
// synthetic ground on the 300 x 300 grid: a -15 m .. +10 m bump field (Tianjin's real range is ~ -13 .. +8 m)
const nx = 300, ny = 300;
const ground = { nx, ny, values: new Float32Array(nx * ny).map((_, i) => -2.5 + 12.5 * Math.sin((i % nx) / 7) * Math.cos(Math.floor(i / nx) / 5)) };

function contains(b: { lo: number[]; hi: number[] }, p: number[]): boolean {
  return p.every((x, c) => x / map.enu_unit_m >= b.lo[c]! && x / map.enu_unit_m <= b.hi[c]!);
}

describe("curved shell bounding box", () => {
  for (const [k, terrain] of [[1, false], [10, false], [1, true], [10, true]] as const) {
    it(`contains every exact shell point, corners included (k=${k}, terrain ${terrain ? "on" : "off"})`, () => {
      const g = terrain ? groundSampler(ground) : null;
      const b = shellBounds(grid, map, g, k, { marginM: 0.5 });
      for (let j = 0; j <= 60; j++) for (let i = 0; i <= 60; i++) {
        const u = i / 60, v = j / 60, h0 = g ? g.at(u, v) : 0;
        for (const h of [h0, h0 + k * grid.top_m]) assert.ok(contains(b, exactEnu(grid, frame, u, v, h)), `u=${u} v=${v} h=${h}`);
      }
    });
  }
  it("reaches below the centre ground: the corners sag with Earth curvature", () => {
    const b = shellBounds(grid, map, null, 1, { marginM: 0 });
    const corner = exactEnu(grid, frame, 0, 0, 0)[2];
    assert.ok(corner < -5, `corner z ${corner} m`);
    assert.ok(Math.abs(b.lo[2]! * map.enu_unit_m - Math.min(corner, exactEnu(grid, frame, 1, 1, 0)[2], exactEnu(grid, frame, 1, 0, 0)[2], exactEnu(grid, frame, 0, 1, 0)[2])) < 1e-6);
  });
});
