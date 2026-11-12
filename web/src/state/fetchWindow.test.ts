import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FETCH_WINDOW_AHEAD, windowFrames } from "./fetchWindow.ts";

describe("sliding fetch window", () => {
  it("uses a window of the current frame plus two ahead by default", () => {
    assert.equal(FETCH_WINDOW_AHEAD, 2);
    assert.deepEqual(windowFrames(0, 7), [0, 1, 2]);
  });

  it("requests floor(t) and the next two frames while the playhead is mid-hour", () => {
    assert.deepEqual(windowFrames(2.4, 7), [2, 3, 4]);
    assert.deepEqual(windowFrames(2, 7), [2, 3, 4]);
  });

  it("does not request a frame past the last one when looping is off", () => {
    assert.deepEqual(windowFrames(6, 7, { loop: false }), [6]);
    assert.deepEqual(windowFrames(5, 7, { loop: false }), [5, 6]);
    assert.deepEqual(windowFrames(4, 7, { loop: false }), [4, 5, 6]);
  });

  it("prefetches frames 0 and 1 when looping on the last frame", () => {
    assert.deepEqual(windowFrames(6, 7, { loop: true }), [6, 0, 1]);
  });

  it("adds only the newly entering frame when playback advances one hour", () => {
    const before = windowFrames(0, 7, { loop: true });
    const after = windowFrames(1, 7, { loop: true });
    assert.deepEqual(before, [0, 1, 2]);
    assert.deepEqual(after, [1, 2, 3]);
    assert.deepEqual(after.filter((f) => !before.includes(f)), [3]);
  });

  it("after a seek keeps only the three frames of the new window", () => {
    assert.deepEqual(windowFrames(5, 7, { loop: true }), [5, 6, 0]);
    assert.deepEqual(windowFrames(5, 7, { loop: false }), [5, 6]);
  });
});
