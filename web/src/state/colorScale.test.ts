import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colorScaleEnds, colorScaleModeOf } from "./colorScale.ts";

describe("color scale ends", () => {
  const display: [number, number] = [0, 25];
  const frame = { min: 5, max: 10 };
  const fallback: [number, number] = [0, 1];

  it("display mode keeps the configured range and ignores the frame", () => {
    const ends = colorScaleEnds("display", display, frame, fallback);
    assert.deepEqual(ends, [0, 25]);
    display[1] = 30;
    assert.deepEqual(ends, [0, 25]);
    display[1] = 25;
  });

  it("frame mode uses that frame's min and max", () => {
    assert.deepEqual(colorScaleEnds("frame", display, frame, fallback), [5, 10]);
  });

  it("frame mode falls back to the configured range when the frame span is missing or flat", () => {
    assert.deepEqual(colorScaleEnds("frame", display, null, fallback), [0, 25]);
    assert.deepEqual(colorScaleEnds("frame", display, { min: 0, max: 0 }, fallback), [0, 25]);
    assert.deepEqual(colorScaleEnds("frame", display, { min: Number.NaN, max: 4 }, fallback), [0, 25]);
  });

  it("uses the fallback when neither the frame nor the configured range is usable", () => {
    assert.deepEqual(colorScaleEnds("frame", null, null, fallback), [0, 1]);
    assert.deepEqual(colorScaleEnds("display", null, frame, fallback), [0, 1]);
    assert.deepEqual(colorScaleEnds("frame", [1, 1], { min: 2, max: 2 }, [3, 4]), [3, 4]);
  });

  it("reads the query as display only for that exact value", () => {
    assert.equal(colorScaleModeOf("display"), "display");
    assert.equal(colorScaleModeOf("frame"), "frame");
    assert.equal(colorScaleModeOf(null), "frame");
    assert.equal(colorScaleModeOf("Display"), "frame");
  });
});
