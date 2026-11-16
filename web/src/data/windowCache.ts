/**
 * Encoded-byte cache for the sliding fetch window.
 * Only frames in the current window are kept; leaving the window evicts the
 * bytes and aborts any in-flight fetch for that frame.
 */
export interface CachedPayload {
  bytes: ArrayBuffer;
  extra?: unknown;
}

export type FrameLoader = (signal: AbortSignal) => Promise<CachedPayload>;

export class WindowByteCache {
  private readonly raw = new Map<string, CachedPayload>();
  private readonly inflight = new Map<
    string,
    { promise: Promise<CachedPayload>; abort: AbortController }
  >();

  has(key: string): boolean {
    return this.raw.has(key);
  }

  get(key: string): CachedPayload | undefined {
    return this.raw.get(key);
  }

  keys(): string[] {
    return [...this.raw.keys()];
  }

  pending(): string[] {
    return [...this.inflight.keys()];
  }

  async load(key: string, loader: FrameLoader): Promise<CachedPayload> {
    const hit = this.raw.get(key);
    if (hit) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending.promise;
    const abort = new AbortController();
    const promise = (async () => {
      try {
        const payload = await loader(abort.signal);
        if (abort.signal.aborted) {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          throw err;
        }
        this.raw.set(key, payload);
        return payload;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, { promise, abort });
    return promise;
  }

  /**
   * Keep only payloads whose frame is in `frames`. Cached bytes outside the
   * window are dropped; in-flight fetches for those frames are aborted.
   */
  retainFrames(frames: Iterable<number>): { evicted: string[]; aborted: string[] } {
    const want = new Set(frames);
    const evicted: string[] = [];
    const aborted: string[] = [];
    for (const k of [...this.raw.keys()]) {
      if (!want.has(frameOf(k))) {
        this.raw.delete(k);
        evicted.push(k);
      }
    }
    for (const [k, entry] of [...this.inflight]) {
      if (!want.has(frameOf(k))) {
        entry.abort.abort();
        aborted.push(k);
      }
    }
    return { evicted, aborted };
  }
}

function frameOf(key: string): number {
  return Number(key.slice(key.lastIndexOf("@") + 1));
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}
