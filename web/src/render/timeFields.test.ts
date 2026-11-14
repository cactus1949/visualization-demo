import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { invalidateShown, shownIsCurrent } from "./shownTarget.ts";

/**
 * reloadFormat releases GPU slots then reloads the same timeline index (e.g. t = 4).
 * The derived speed target only re-blends when speedShown is cleared by invalidate();
 * releaseOutside() does not touch it, so a format switch at the same t would otherwise
 * keep the previous encoding's speed field.
 */
describe("speed target freshness after a same-t reload", () => {
  it("treats a matching (a, b, s) as current, so blend would skip the speed pass", () => {
    const shown = { a: 4, b: 4, s: 0 };
    assert.equal(shownIsCurrent(shown, 4, 4, 0, true), true);
    assert.equal(shownIsCurrent(shown, 4, 5, 0, true), false);
    assert.equal(shownIsCurrent(shown, 4, 4, 0, false), false);
  });

  it("invalidateShown forces a re-blend of the same t (what reloadFormat must call)", () => {
    const shown = { a: 4, b: 4, s: 0 };
    invalidateShown(shown);
    assert.equal(shownIsCurrent(shown, 4, 4, 0, true), false);
  });
});
