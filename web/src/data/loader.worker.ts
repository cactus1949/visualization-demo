import type { Manifest } from "./manifest";

let manifest: Manifest;
let dataRoot = "";
const cache = new Set<string>();

async function loadVariable(name: string): Promise<void> {
  if (cache.has(name)) return;
  const meta = manifest.variables[name];
  if (!meta) return;
  const response = await fetch(dataRoot + meta.file);
  if (!response.ok) throw new Error(`无法加载 ${name}: ${response.status}`);
  const buffer = await response.arrayBuffer();
  cache.add(name);
  (self as any).postMessage({ type: "data", name, buffer }, [buffer]);
}

self.onmessage = async (event: MessageEvent) => {
  try {
    if (event.data.type === "load") {
      dataRoot = event.data.url.replace(/manifest\.json$/, "");
      const response = await fetch(event.data.url);
      if (!response.ok) throw new Error(`清单加载失败: ${response.status}`);
      manifest = (await response.json()) as Manifest;
      postMessage({ type: "manifest", manifest });
      for (const name of ["u", "v", "w"]) await loadVariable(name);
      for (const name of ["tke", "t2m"]) await loadVariable(name);
    } else if (event.data.type === "request") {
      await loadVariable(event.data.name);
    }
  } catch (error) {
    postMessage({ type: "error", message: String(error) });
  }
};
