import { timesOf, type Manifest, type VariableMeta } from "./manifest";

export interface LoadedVariable {
  meta: VariableMeta;
  data: Float32Array;
}

export interface FileTiming {
  fetchMs: number;
  decodeMs: number;
  bytes: number;
}

export type WantJob = { kind: "fetch" | "decode" | "wind"; name: string; frame: number; half?: boolean };

/** Event names passed to listeners: "manifest", a variable name, "wind", "cached", "error". */
export type StoreEvent = { name: string; frame: number };

/**
 * Main-thread side of the data worker. Variables are keyed by `name@frame`; schema-3 data
 * is frame 0. The main thread only keeps Float32 for the frames it is asked to retain (the
 * worker keeps the encoded bytes of every frame), and hands half-float payloads straight to
 * the GPU slot uploader.
 */
export class DataStore {
  manifest: Manifest | null = null;
  frames = 1;
  /** `${name}@${frame}` -> physical values */
  readonly values = new Map<string, LoadedVariable>();
  /** half-float payloads waiting for a GPU slot: `${name}@${frame}` and `wind@${frame}` */
  readonly halves = new Map<string, Uint16Array>();
  /** encoded bytes present in the worker cache (`${name}@${frame}`) */
  readonly cached = new Set<string>();
  /** jobs sent to the worker that have not reported back yet */
  readonly pending = new Set<string>();
  readonly fileTimings: Record<string, FileTiming> = {};
  manifestFetchMs: number | null = null;
  lastError = "";
  readonly worker: Worker;
  private readonly listeners = new Set<(name: string, frame: number) => void>();
  private lastWant = "";

  constructor(manifestUrl: string) {
    this.worker = new Worker(new URL("./loader.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent) => this.receive(event.data);
    this.worker.postMessage({ type: "load", url: manifestUrl });
  }

  static key(name: string, frame: number): string {
    return `${name}@${frame}`;
  }

  private receive(m: any): void {
    if (m.type === "manifest") {
      this.manifest = m.manifest as Manifest;
      this.frames = timesOf(this.manifest).length;
      if (m.timing) this.manifestFetchMs = m.timing.fetchMs;
      this.notify("manifest", 0);
      return;
    }
    if (m.type === "error") {
      this.lastError = String(m.message);
      if (m.fatal) this.notify("error", -1);
      return;
    }
    if (m.type === "done") {
      this.pending.delete(DataStore.jobKey(m.job));
      return;
    }
    if (m.type === "cached") {
      this.cached.add(DataStore.key(m.name, m.frame));
      if (m.frame === 0 && m.timing && !this.fileTimings[m.name])
        this.fileTimings[m.name] = { fetchMs: m.timing.fetchMs, decodeMs: 0, bytes: m.timing.bytes };
      this.notify("cached", m.frame);
      return;
    }
    if (m.type === "evicted") {
      this.cached.delete(DataStore.key(m.name, m.frame));
      this.notify("cached", m.frame);
      return;
    }
    if (!this.manifest) return;
    if (m.type === "wind") {
      this.halves.set(DataStore.key("wind", m.frame), new Uint16Array(m.half));
      this.notify("wind", m.frame);
      return;
    }
    if (m.type === "data") {
      const k = DataStore.key(m.name, m.frame);
      if (m.timing && m.frame === 0) this.fileTimings[m.name] = m.timing;
      this.values.set(k, { meta: this.manifest.variables[m.name]!, data: new Float32Array(m.buffer) });
      if (m.half) this.halves.set(k, new Uint16Array(m.half));
      this.notify(m.name, m.frame);
    }
  }

  static jobKey(j: WantJob): string {
    return `${j.kind}:${j.name}@${j.frame}${j.half ? "+h" : ""}`;
  }

  get(name: string, frame: number): LoadedVariable | undefined {
    return this.values.get(DataStore.key(name, frame));
  }

  isCached(name: string, frame: number): boolean {
    return this.cached.has(DataStore.key(name, frame));
  }

  /** Replace the worker's queue (highest priority first). Re-sent only when it changes. */
  want(jobs: WantJob[]): void {
    const text = jobs.map(DataStore.jobKey).join("|");
    if (text === this.lastWant) return;
    this.lastWant = text;
    // Jobs dropped from the list are discarded by the worker unless already running;
    // running ones still report "done" (and their result) later.
    this.pending.clear();
    for (const j of jobs) this.pending.add(DataStore.jobKey(j));
    this.worker.postMessage({ type: "want", jobs });
  }

  isPending(j: WantJob): boolean {
    return this.pending.has(DataStore.jobKey(j));
  }

  /** Drop Float32 copies the caller no longer needs (the worker still has the bytes). */
  retain(keep: (name: string, frame: number) => boolean): void {
    for (const k of [...this.values.keys()]) {
      const at = k.lastIndexOf("@");
      if (!keep(k.slice(0, at), Number(k.slice(at + 1)))) this.values.delete(k);
    }
  }

  takeHalf(name: string, frame: number): Uint16Array | undefined {
    const k = DataStore.key(name, frame);
    const h = this.halves.get(k);
    if (h) this.halves.delete(k);
    return h;
  }

  on(listener: (name: string, frame: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.worker.terminate();
    this.listeners.clear();
  }

  private notify(name: string, frame: number): void {
    this.listeners.forEach((listener) => listener(name, frame));
  }
}
