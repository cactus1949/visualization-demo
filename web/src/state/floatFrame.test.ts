import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampFloatBox } from "./floatFrame.ts";

describe("section config frame", () => {
  it("keeps the title bar inside the stage after a drag or a viewport shrink", () => {
    const dragged = clampFloatBox({ x: 900, y: -40, width: 280, height: 420 }, { width: 640, height: 480 });
    assert.equal(dragged.x, 360);
    assert.equal(dragged.y, 0);
    const shrunk = clampFloatBox({ x: 400, y: 500, width: 280, height: 420 }, { width: 320, height: 200 });
    assert.equal(shrunk.x, 40);
    assert.equal(shrunk.y, 164);
  });
});
