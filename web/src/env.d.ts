export {};

declare global {
  interface Window {
    __atmosReady?: boolean;
    __atmosStatus?: {
      backend: string;
      particlePath: string;
      particleSample?: number[];
    };
  }
}
