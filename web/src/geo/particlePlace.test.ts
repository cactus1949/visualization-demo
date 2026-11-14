import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enuFrameAt, exactEnu, polyForward, type GeoGrid, type GeoMap } from "./mapping.ts";
import { ellipsoidHeight, sampleGrid } from "./placement.ts";
import { PARTICLE_MIN_AGL_KM, particleBoxKm, particlePlacementState, particleEllipsoidHeight, particleUvAgl, placementKey, type GridPos } from "./particlePlace.ts";

const { grid, map } = JSON.parse(readFileSync(new URL("./testdata/tianjin-map.json", import.meta.url), "utf8")) as { grid: GeoGrid; map: GeoMap };
const frame = enuFrameAt(map.lon0, map.lat0);
const nx = 300, ny = 300;
const ground = {
  nx,
  ny,
  values: new Float32Array(nx * ny).map((_, i) => -2.5 + 12.5 * Math.sin((i % nx) / 7) * Math.cos(Math.floor(i / nx) / 5)),
};
const f32 = Math.fround;

// deterministic particle nodes over the default spawn band (20-300 m) and the full column
function nodes(n: number): GridPos[] {
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  return Array.from({ length: n }, () => [rnd(), rnd(), PARTICLE_MIN_AGL_KM + rnd() * 1.2] as const);
}

describe("globe particle placement (CPU reference of the place pass)", () => {
  it("grid state maps to the same (u, v) the box tab draws it at", () => {
    const sx = 30.2, sz = 33.4;
    for (const g of nodes(200)) {
      const [x, y, z] = particleBoxKm(sx, sz, g);
      // buildings / sections: u = x / sx + 0.5, v = 0.5 - z / sz, AGL = y km * 1000
      const p = particleUvAgl(g);
      assert.ok(Math.abs(x / sx + 0.5 - p.u) < 1e-12);
      assert.ok(Math.abs(0.5 - z / sz - p.v) < 1e-12);
      assert.ok(Math.abs(y * 1000 - p.agl) < 1e-9);
    }
  });

  it("k scales only the height above ground; terrain off ignores the ground", () => {
    assert.equal(particleEllipsoidHeight(12, true, 3, 0.125), ellipsoidHeight(12, 3, 125));
    assert.equal(particleEllipsoidHeight(12, false, 3, 0.125), 375);
    assert.equal(particleEllipsoidHeight(-4, true, 10, 0), -4);
  });

  it("float32 polynomial placement matches the exact path within 1 cm (k = 1, 3, 10; terrain on / off)", () => {
    let worst = 0;
    for (const k of [1, 3, 10]) {
      for (const terrain of [false, true]) {
        for (const g of nodes(400)) {
          const { u, v, agl } = particleUvAgl(g);
          const gM = sampleGrid(ground, u, v);
          const h = particleEllipsoidHeight(gM, terrain, k, g[2]);
          const exact = exactEnu(grid, frame, u, v, h);
          const gpu = polyForward(map, f32(u), f32(v), f32(h), f32);
          worst = Math.max(worst, Math.hypot(gpu[0] - exact[0], gpu[1] - exact[1], gpu[2] - exact[2]));
          assert.ok(agl >= PARTICLE_MIN_AGL_KM * 1000 - 1e-9);
        }
      }
    }
    assert.ok(worst < 0.01, `worst ${worst} m`);
  });

  it("a live particle never sits below its ground (clearance >= k * 3 m)", () => {
    for (const k of [1, 3, 10]) {
      for (const g of nodes(300)) {
        const { u, v } = particleUvAgl(g);
        const gM = sampleGrid(ground, u, v);
        const h = particleEllipsoidHeight(gM, true, k, Math.max(g[2], PARTICLE_MIN_AGL_KM));
        assert.ok(h - gM >= k * PARTICLE_MIN_AGL_KM * 1000 - 1e-6);
      }
    }
  });

  it("placement key changes with k or terrain only", () => {
    assert.equal(placementKey(3, 0), placementKey(3, 0.2));
    assert.notEqual(placementKey(3, 0), placementKey(3, 1));
    assert.notEqual(placementKey(3, 1), placementKey(2.5, 1));
  });

  it("placement state: unplaced until a place pass ran and no reset is pending", () => {
    assert.equal(particlePlacementState("", false), "unplaced"); // fresh targets (count changed while hidden)
    assert.equal(particlePlacementState("", true), "unplaced");
    assert.equal(particlePlacementState(placementKey(1, 0), true), "unplaced"); // height / count change pending
    assert.equal(particlePlacementState(placementKey(1, 0), false), "placed");
  });
});
