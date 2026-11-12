import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAbortError, WindowByteCache, type CachedPayload } from "./windowCache.ts";

const empty = (): CachedPayload => ({ bytes: new ArrayBuffer(4) });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("window byte cache", () => {
  it("drops cached frames that have left the window and keeps the ones still inside", async () => {
    const cache = new WindowByteCache();
    await cache.load("u@0", async () => empty());
    await cache.load("u@1", async () => empty());
    await cache.load("v@0", async () => empty());
    const { evicted, aborted } = cache.retainFrames([1, 2]);
    assert.deepEqual(evicted.sort(), ["u@0", "v@0"]);
    assert.deepEqual(aborted, []);
    assert.equal(cache.has("u@1"), true);
    assert.equal(cache.has("u@0"), false);
    assert.equal(cache.has("v@0"), false);
  });

  it("aborts in-flight fetches for frames that a seek has left behind", async () => {
    const cache = new WindowByteCache();
    const gate = deferred<void>();
    let started = 0;
    let sawAbort = false;
    const pending = cache.load("u@0", async (signal) => {
      started += 1;
      signal.addEventListener("abort", () => {
        sawAbort = true;
      });
      await gate.promise;
      if (signal.aborted) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return empty();
    });
    // A seek that leaves frame 0 outside the new window.
    const { aborted, evicted } = cache.retainFrames([5, 6]);
    assert.deepEqual(aborted, ["u@0"]);
    assert.deepEqual(evicted, []);
    assert.equal(cache.pending().includes("u@0"), true);
    gate.resolve();
    await assert.rejects(pending, (e: unknown) => isAbortError(e));
    assert.equal(sawAbort, true);
    assert.equal(started, 1);
    assert.equal(cache.has("u@0"), false);
  });

  it("does not cache a payload that arrives after its fetch was aborted", async () => {
    const cache = new WindowByteCache();
    const gate = deferred<void>();
    const pending = cache.load("tke@1", async (signal) => {
      await gate.promise;
      return empty();
    });
    cache.retainFrames([5, 6]);
    gate.resolve();
    await assert.rejects(pending, (e: unknown) => isAbortError(e));
    assert.equal(cache.has("tke@1"), false);
  });

  it("starts a new fetch for a key after the previous in-flight request was cancelled", async () => {
    const cache = new WindowByteCache();
    const first = deferred<void>();
    const stale = cache.load("u@0", async (signal) => {
      await first.promise;
      if (signal.aborted) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return empty();
    });
    cache.retainFrames([5]);
    first.resolve();
    await stale.catch(() => undefined);
    let loads = 0;
    const payload = await cache.load("u@0", async () => {
      loads += 1;
      return empty();
    });
    assert.equal(loads, 1);
    assert.equal(payload.bytes.byteLength, 4);
    assert.equal(cache.has("u@0"), true);
  });

  it("after a seek to a 3-frame window, drops jobs outside it and never writes aborted results", async () => {
    const cache = new WindowByteCache();
    await cache.load("u@0", async () => empty());
    const late = deferred<CachedPayload>();
    const stale = cache.load("u@1", async (signal) => {
      const payload = await late.promise;
      if (signal.aborted) {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return payload;
    });
    // Seek from t=0 (window [0, 1, 2]) to t=5 with looping: window is [5, 6, 0].
    const { evicted, aborted } = cache.retainFrames([5, 6, 0]);
    assert.deepEqual(evicted.sort(), []);
    assert.deepEqual(aborted, ["u@1"]);
    assert.equal(cache.has("u@0"), true, "frame 0 stays because the new window wraps to it");
    late.resolve(empty());
    await assert.rejects(stale, (e: unknown) => isAbortError(e));
    assert.equal(cache.has("u@1"), false);
    assert.deepEqual(cache.keys().sort(), ["u@0"]);
  });
});
