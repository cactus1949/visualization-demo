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
    // The new window after a jump from t=0 to t=5 is frames 5 and 6.
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
});
