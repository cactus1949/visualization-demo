import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectLayerVariable, toggleLayer } from "./elementMode.ts";

describe("layer switch and dropdown", () => {
  it("flips only the switch and keeps the current variable", () => {
    assert.deepEqual(toggleLayer({ on: true, variable: "speed0" }), { on: false, variable: "speed0" });
    assert.deepEqual(toggleLayer({ on: false, variable: "t2m" }), { on: true, variable: "t2m" });
  });

  it("replaces the variable without turning the layer on or off", () => {
    assert.deepEqual(selectLayerVariable({ on: true, variable: "speed" }, "u_gust"), {
      on: true,
      variable: "u_gust",
    });
    assert.deepEqual(selectLayerVariable({ on: false, variable: "speed" }, "tke"), {
      on: false,
      variable: "tke",
    });
  });

  it("keeps a ground choice from changing the volume choice", () => {
    const ground = selectLayerVariable({ on: true, variable: "speed0" }, "t2m");
    const volume = toggleLayer({ on: true, variable: "speed" });
    assert.equal(ground.variable, "t2m");
    assert.equal(ground.on, true);
    assert.deepEqual(volume, { on: false, variable: "speed" });
  });
});
