import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SPEED, canShowFrames, planOf, type FramePresence, type LayerNeed, type VariableRef } from "./openVariables.ts";

const stored: Record<string, VariableRef> = {
  u: { dims: ["z", "lat", "lon"], encoding: "f16" },
  v: { dims: ["z", "lat", "lon"], encoding: "f16" },
  w: { dims: ["z", "lat", "lon"], encoding: "u8_linear" },
  tke: { dims: ["z", "lat", "lon"], encoding: "u8_linear" },
  t2m: { dims: ["lat", "lon"], encoding: "u8_linear" },
  ustar: { dims: ["lat", "lon"], encoding: "sz3" },
  cloud: { dims: ["lat", "lon"], encoding: "sz3" },
};

const sz3Derived: Record<string, VariableRef> = {
  ...stored,
  sigma_u: {
    dims: ["z", "lat", "lon"],
    encoding: "derived",
    derive: { op: "profile", from: "ustar" },
  },
  u_gust: {
    dims: ["z", "lat", "lon"],
    encoding: "derived",
    derive: { op: "gust", u: "u", v: "v", sigma: "sigma_u" },
  },
  cloud_low: {
    dims: ["lat", "lon"],
    encoding: "derived",
    derive: { op: "copy", from: "cloud" },
  },
};

function layers(partial: Partial<LayerNeed> = {}): LayerNeed {
  return {
    particles: false,
    ground: false,
    groundVar: "none",
    volume: false,
    volumeVar: "tke",
    section: false,
    sectionVar: SPEED,
    probe: false,
    probeVar: SPEED,
    ...partial,
  };
}

function presence(opts?: { wind?: number[]; scalar?: Record<string, number[]>; cpu?: Record<string, number[]> }): FramePresence {
  const wind = new Set(opts?.wind ?? []);
  const scalar = new Map(Object.entries(opts?.scalar ?? {}).map(([name, frames]) => [name, new Set(frames)]));
  const cpu = new Map(Object.entries(opts?.cpu ?? {}).map(([name, frames]) => [name, new Set(frames)]));
  return {
    wind: (frame) => wind.has(frame),
    scalar: (name, frame) => scalar.get(name)?.has(frame) ?? false,
    cpu: (name, frame) => cpu.get(name)?.has(frame) ?? false,
  };
}

describe("open layer variable selection", () => {
  it("with particles off and only near-surface wind speed, requests u and v, not w, and canShow waits for CPU not wind", () => {
    const plan = planOf(layers({ ground: true, groundVar: "speed0" }), stored);
    assert.deepEqual(plan.names, ["u", "v"]);
    assert.deepEqual(plan.cpuNames, ["u", "v"]);
    assert.equal(plan.names.includes("w"), false);
    assert.equal(plan.queueWind, false);
    assert.equal(plan.includeW, false);
    assert.equal(canShowFrames(0, 1, plan, presence()), false);
    assert.equal(
      canShowFrames(0, 1, plan, presence({ cpu: { u: [0, 1], v: [0, 1] } })),
      true,
    );
    assert.equal(
      canShowFrames(0, 1, plan, presence({ wind: [0, 1], cpu: { u: [0], v: [0, 1] } })),
      false,
    );
  });

  it("with only a tke volume or height slice, requests only tke and canShow waits for tke slots, not wind", () => {
    for (const plan of [
      planOf(layers({ volume: true, volumeVar: "tke" }), stored),
      planOf(layers({ section: true, sectionVar: "tke" }), stored),
    ]) {
      assert.deepEqual(plan.names, ["tke"]);
      assert.deepEqual(plan.gpuScalars, ["tke"]);
      assert.equal(plan.queueWind, false);
      assert.equal(
        canShowFrames(0, 0, plan, presence({ scalar: { tke: [0] }, cpu: { tke: [0] } })),
        true,
      );
      assert.equal(canShowFrames(0, 0, plan, presence({ wind: [0], cpu: { tke: [0] } })), false);
      assert.equal(canShowFrames(0, 0, plan, presence({ scalar: { tke: [0] } })), false);
    }
  });

  it("with all wind-related layers off, does not queue a wind job and canShow does not wait for wind", () => {
    const plan = planOf(layers({ ground: true, groundVar: "t2m" }), stored);
    assert.deepEqual(plan.names, ["t2m"]);
    assert.equal(plan.queueWind, false);
    assert.equal(canShowFrames(0, 0, plan, presence({ cpu: { t2m: [0] } })), true);
    const idle = planOf(layers(), stored);
    assert.deepEqual(idle.names, []);
    assert.equal(idle.queueWind, false);
    assert.equal(canShowFrames(0, 1, idle, presence()), true);
  });

  it("with particles on, requests u, v and w and queues a wind job that includes w", () => {
    const plan = planOf(layers({ particles: true }), stored);
    assert.deepEqual(plan.names, ["u", "v", "w"]);
    assert.equal(plan.queueWind, true);
    assert.equal(plan.includeW, true);
    assert.equal(canShowFrames(0, 0, plan, presence()), false);
    assert.equal(canShowFrames(0, 0, plan, presence({ wind: [0] })), true);
  });

  it("with particles off and volume showing horizontal speed, queues wind without w and requests only u and v", () => {
    const plan = planOf(layers({ volume: true, volumeVar: SPEED }), stored);
    assert.deepEqual(plan.names, ["u", "v"]);
    assert.equal(plan.names.includes("w"), false);
    assert.equal(plan.needSpeed, true);
    assert.equal(plan.queueWind, true);
    assert.equal(plan.includeW, false);
    assert.equal(canShowFrames(0, 1, plan, presence({ cpu: { u: [0, 1], v: [0, 1] } })), false);
    assert.equal(
      canShowFrames(0, 1, plan, presence({ wind: [0, 1], cpu: { u: [0, 1], v: [0, 1] } })),
      true,
    );
  });

  it("requests derived sources only when those layers are on", () => {
    const gust = planOf(layers({ volume: true, volumeVar: "u_gust" }), sz3Derived);
    assert.deepEqual(gust.names, ["sigma_u", "u", "u_gust", "ustar", "v"]);
    assert.equal(gust.names.includes("w"), false);
    assert.equal(gust.names.includes("cloud"), false);
    assert.deepEqual(gust.gpuScalars, ["u_gust"]);

    const low = planOf(layers({ ground: true, groundVar: "cloud_low" }), sz3Derived);
    assert.deepEqual(low.names, ["cloud", "cloud_low"]);
    assert.equal(low.names.includes("u"), false);
    assert.equal(low.names.includes("v"), false);
    assert.equal(low.names.includes("w"), false);
    assert.equal(low.queueWind, false);
  });
});
