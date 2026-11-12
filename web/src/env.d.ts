/// <reference types="vite/client" />
export {};

declare global {
  interface Window {
    __atmosReady?: boolean;
    __atmosStatus?: Record<string, unknown> & { fps?: number; buildings?: number };
    __atmosApi?: Record<string, (...args: any[]) => unknown>;
    __atmosStart?: number;
    __atmosTimings?: Record<string, unknown>;
  }
}

interface ImportMetaEnv {
  readonly VITE_DATA_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
