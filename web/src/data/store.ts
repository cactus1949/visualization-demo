import type { Manifest, VariableMeta } from "./manifest";

export interface LoadedVariable {
  meta: VariableMeta;
  data: Float32Array;
}

export interface FileTiming {
  fetchMs: number;
  decodeMs: number;
  bytes: number;
}

export class DataStore {
  manifest: Manifest | null = null;
  loaded = new Map<string, LoadedVariable>();
  loading = new Set<string>();
  readonly fileTimings: Record<string, FileTiming> = {};
  manifestFetchMs: number | null = null;
  readonly worker: Worker;
  private readonly listeners = new Set<(name: string) => void>();

  constructor(manifestUrl: string) {
    this.worker = new Worker(new URL("./loader.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent) => {
      const message = event.data as
        | { type: "manifest"; manifest: Manifest; timing?: { fetchMs: number } }
        | { type: "data"; name: string; buffer: ArrayBuffer; timing?: FileTiming };
      if (message.type === "manifest") {
        this.manifest = message.manifest;
        if (message.timing) this.manifestFetchMs = message.timing.fetchMs;
        this.notify("manifest");
        return;
      }
      if (!this.manifest) return;
      if (message.timing) this.fileTimings[message.name] = message.timing;
      this.loaded.set(message.name, {
        meta: this.manifest.variables[message.name],
        data: new Float32Array(message.buffer),
      });
      this.loading.delete(message.name);
      this.notify(message.name);
    };
    this.worker.postMessage({ type: "load", url: manifestUrl });
  }

  on(listener: (name: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(name: string): void {
    if (!this.loaded.has(name) && !this.loading.has(name)) {
      this.loading.add(name);
      this.worker.postMessage({ type: "request", name });
    }
  }

  dispose(): void {
    this.worker.terminate();
    this.listeners.clear();
  }

  private notify(name: string): void {
    this.listeners.forEach((listener) => listener(name));
  }
}
