import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VIEWS, presetCamera } from "./viewPresets.ts";

// Tianjin grid: ~17.97 km × 18.02 km (geo.json grid corners, see mapping.test.ts)
const SIZE: [number, number] = [17970, 18020];
const inside = (x: number) => x >= 0 && x <= 1;

describe("globe view presets", () => {
  it("西南角 looks at a point inside the data", () => {
    const [u, v] = VIEWS.corner!;
    assert.ok(inside(u) && inside(v), `target ${u}, ${v}`);
    assert.ok(u > 0.1 && v > 0.1, "target is not on the domain edge");
  });
  it("西南角 camera is above the domain, south-west of the target, looking north-east and down", () => {
    const [u, v, hd, pt] = VIEWS.corner!;
    const c = presetCamera(VIEWS.corner!, SIZE);
    assert.ok(inside(c.u) && inside(c.v), `camera grid ${c.u.toFixed(3)}, ${c.v.toFixed(3)}`);
    assert.ok(c.u < u && c.v < v, "camera south-west of the target");
    assert.ok(hd > 0 && hd < 90, "heading between north and east");
    assert.ok(pt < 0, "looks down");
  });
  it("西南角 camera height clears the tallest building at k = 1 and k = 3 (415 m × k)", () => {
    const c = presetCamera(VIEWS.corner!, SIZE);
    for (const k of [1, 3]) assert.ok(c.heightM > 415 * k + 300, `height ${c.heightM.toFixed(0)} m, k ${k}`);
  });
  it("the old corner preset put the camera outside the domain (regression guard for the geometry)", () => {
    const c = presetCamera([0, 0, 45, -12, 2500], SIZE);
    assert.ok(c.u < 0 && c.v < 0);
    // measured in the app: camera 1.73 km west and south of the SW corner at ~520 m
    assert.ok(Math.abs(c.u * SIZE[0] + 1729) < 5 && Math.abs(c.heightM - 520) < 1);
  });
  it("overview and top keep their parameters", () => {
    assert.deepEqual(VIEWS.overview, [0.5, 0.5, 20, -35, 32000]);
    assert.deepEqual(VIEWS.top, [0.5, 0.5, 0, -89.9, 30000]);
  });
});
