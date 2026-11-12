import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { advance, createTimeline, SECONDS_PER_HOUR, type TimelineState } from "./timeline.ts";

/** Same contract as AtmosViewer's canShow: both bracketing frames must be resident. */
function canShowReady(ready: ReadonlySet<number>) {
  return (a: number, b: number) => ready.has(a) && ready.has(b);
}

function playingAt(t: number, extras: Partial<TimelineState> = {}): TimelineState {
  const tl = createTimeline();
  tl.frames = 7;
  tl.t = t;
  tl.playing = true;
  tl.rate = 4;
  tl.smooth = true;
  tl.loop = true;
  Object.assign(tl, extras);
  return tl;
}

describe("playback across an hour boundary", () => {
  it("stops at the hour and waits when the next frame is not ready, and does not skip", () => {
    const ready = new Set([0]);
    const tl = playingAt(0.8);
    // At 4×, dt seconds of screen time advance dt hours of data.
    // This step would go to 1.3 if it were allowed to cross freely.
    advance(tl, 0.5, canShowReady(ready));
    assert.equal(tl.buffering, true);
    assert.ok(tl.t < 1, `expected to stay before hour 1, got t=${tl.t}`);
    assert.ok(tl.playing);

    // Further steps that would skip well past the hour must not jump to 1 or 2.
    for (let i = 0; i < 8; i += 1) {
      advance(tl, 1, canShowReady(ready));
      assert.equal(tl.buffering, true);
      assert.ok(tl.t < 1, `skipped the hour wait: t=${tl.t} on step ${i}`);
      assert.ok(tl.t !== 2 && tl.t < 2);
    }

    // Once the hour itself is resident, playback may land on it, but must wait
    // there until the following frame is ready (no skip into (1, 2]).
    ready.add(1);
    const onHour = playingAt(1);
    advance(onHour, 0.25, canShowReady(ready));
    assert.equal(onHour.buffering, true);
    assert.equal(onHour.t, 1);
    advance(onHour, 2, canShowReady(ready));
    assert.equal(onHour.t, 1, "must not skip into the next interval while it is not ready");
  });

  it("crosses the hour once the next frame becomes ready", () => {
    const ready = new Set([0, 1]);
    const tl = playingAt(0.8);
    advance(tl, 0.5, canShowReady(ready));
    assert.equal(tl.buffering, false);
    assert.equal(tl.t, 1);

    ready.add(2);
    advance(tl, 0.25, canShowReady(ready));
    assert.equal(tl.buffering, false);
    assert.ok(tl.t > 1, `expected to leave the hour after frame 2 is ready, got t=${tl.t}`);
    assert.ok(tl.t < 2);
  });

  it("does not advance while buffering just because a large dt is applied", () => {
    const ready = new Set([3]);
    const tl = playingAt(3);
    // A 4× step of SECONDS_PER_HOUR would be a whole hour of data.
    advance(tl, SECONDS_PER_HOUR, canShowReady(ready));
    assert.equal(tl.buffering, true);
    assert.equal(tl.t, 3);
  });
});
