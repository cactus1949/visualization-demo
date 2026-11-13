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
  /** Tianditu browser key for the globe tab basemap */
  readonly VITE_TIANDITU_TK?: string;
  /** `esri`: dev-only Esri imagery fallback for the globe tab (ignored by `vite build`) */
  readonly VITE_DEV_BASEMAP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
