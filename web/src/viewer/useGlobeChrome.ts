/**
 * Cesium 地球模式的界面同步状态（底图样式、垂直夸张 k、地形开关与视角预设）。
 */
import { ref } from "vue";

export function useGlobeChrome() {
  const globeBasemap = ref<"img" | "vec">("img");
  const chromeK = ref(3);
  const globeTerrain = ref(false);

  function globeStatus(): { terrain?: boolean; style?: string; k?: number } | null {
    const status = window.__globeApi?.status;
    if (typeof status !== "function") return null;
    const value = status();
    if (!value || typeof value !== "object") return null;
    return value as { terrain?: boolean; style?: string; k?: number };
  }

  function syncGlobeChrome(): void {
    const globe = globeStatus();
    if (!globe) return;
    if (typeof globe.terrain === "boolean") globeTerrain.value = globe.terrain;
    if (globe.style === "img" || globe.style === "vec") globeBasemap.value = globe.style;
    if (typeof globe.k === "number") chromeK.value = globe.k;
  }

  function setGlobeBasemap(style: "img" | "vec"): void {
    globeBasemap.value = style;
    const setBasemap = window.__globeApi?.setBasemap;
    if (typeof setBasemap === "function") setBasemap(style);
  }

  function setGlobeK(k: number): void {
    chromeK.value = k;
    const setExaggeration = window.__globeApi?.setExaggeration;
    if (typeof setExaggeration === "function") setExaggeration(k);
  }

  function setGlobeTerrain(on: boolean): void {
    globeTerrain.value = on;
    const setTerrain = window.__globeApi?.setTerrain;
    if (typeof setTerrain === "function") setTerrain(on);
  }

  function setGlobeView(name: string): void {
    const setView = window.__globeApi?.setView;
    if (typeof setView === "function") setView(name);
  }

  return {
    globeBasemap,
    chromeK,
    globeTerrain,
    syncGlobeChrome,
    setGlobeBasemap,
    setGlobeK,
    setGlobeTerrain,
    setGlobeView,
  };
}
