import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FETCH_WINDOW_AHEAD,
  keysOutsideFrames,
  keysOnFrames,
  windowFrames,
} from "./fetchWindow.ts";

describe("sliding fetch window", () => {
  it("uses a window of the current frame plus one ahead by default", () => {
    assert.equal(FETCH_WINDOW_AHEAD, 1);
    assert.deepEqual(windowFrames(0, 7), [0, 1]);
  });

  it("requests only floor(t) and floor(t)+1 while the playhead is mid-hour", () => {
    assert.deepEqual(windowFrames(2.4, 7), [2, 3]);
    assert.deepEqual(windowFrames(2, 7), [2, 3]);
  });

  it("does not request a frame past the last one when looping is off", () => {
    assert.deepEqual(windowFrames(6, 7, { loop: false }), [6]);
    assert.deepEqual(windowFrames(5, 7, { loop: false }), [5, 6]);
  });

  it("keeps frame 0 as the next buffer when looping on the last frame", () => {
    assert.deepEqual(windowFrames(6, 7, { loop: true }), [6, 0]);
  });

  it("a seek from t=0 to t=5 marks the old window keys as stale and the new window keys as kept", () => {
    const names = ["u", "v", "w"];
    const held = names.flatMap((n) => [`${n}@0`, `${n}@1`, `${n}@2`]);
    const next = windowFrames(5, 7);
    assert.deepEqual(next, [5, 6]);
    assert.deepEqual(
      keysOutsideFrames(held, next).sort(),
      names.flatMap((n) => [`${n}@0`, `${n}@1`, `${n}@2`]).sort(),
    );
    const incoming = names.flatMap((n) => next.map((f) => `${n}@${f}`));
    assert.deepEqual(keysOnFrames(incoming, next).sort(), incoming.sort());
    assert.deepEqual(keysOnFrames(held, next), []);
  });

  it("does not treat a closed variable's keys as part of the requests to issue", () => {
    const open = ["u", "v", "w"];
    const frames = windowFrames(0, 7);
    const toRequest = open.flatMap((n) => frames.map((f) => `${n}@${f}`));
    assert.deepEqual(toRequest.sort(), ["u@0", "u@1", "v@0", "v@1", "w@0", "w@1"].sort());
    assert.ok(!toRequest.includes("tke@0"));
    assert.ok(!toRequest.includes("t2m@0"));
  });
});
