import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyParticlePreset,
  clampParticleHeightRange,
  matchParticlePreset,
  PARTICLE_PRESETS,
} from "./particlePresets.ts";

describe("particle presets", () => {
  it("matches default particle values as balanced", () => {
    const defaults = PARTICLE_PRESETS.find((p) => p.id === "balanced")!.values;
    assert.equal(matchParticlePreset({ ...defaults }), "balanced");
  });

  it("applies preset style without overwriting height range, coloring or paused state", () => {
    const state = {
      ...PARTICLE_PRESETS[0]!.values,
      colorMode: "height" as const,
      colormap: "plasma",
      color: "#ffffff",
      heightMin: 100,
      heightMax: 600,
      paused: true,
    };
    applyParticlePreset(state, "vivid");
    assert.equal(matchParticlePreset(state), "vivid");
    assert.equal(state.colorMode, "height");
    assert.equal(state.colormap, "plasma");
    assert.equal(state.color, "#ffffff");
    assert.equal(state.heightMin, 100);
    assert.equal(state.heightMax, 600);
    assert.equal(state.paused, true);
  });

  it("reports custom when any preset parameter is tweaked", () => {
    const state = { ...PARTICLE_PRESETS[0]!.values };
    applyParticlePreset(state, "streamline");
    assert.equal(matchParticlePreset(state), "streamline");
    state.lineWidth = 3.5;
    assert.equal(matchParticlePreset(state), "custom");
  });

  it("defines distinct presets with valid trail limits for their particle count", () => {
    const ids = new Set(PARTICLE_PRESETS.map((p) => p.id));
    assert.equal(ids.size, PARTICLE_PRESETS.length);
    for (const p of PARTICLE_PRESETS) {
      const maxTrail = p.values.count > 70000 ? 32 : 64;
      assert.ok(p.values.trailLength <= maxTrail, `${p.id} trailLength exceeds ${maxTrail}`);
    }
  });

  it("clamps particle height range to valid bounds", () => {
    assert.deepEqual(clampParticleHeightRange(20, 300), [20, 300]);
    assert.deepEqual(clampParticleHeightRange(0, 1200), [10, 1000]);
    assert.deepEqual(clampParticleHeightRange(500, 200), [500, 500]);
    assert.deepEqual(clampParticleHeightRange(10, 20), [10, 40]);
  });
});
