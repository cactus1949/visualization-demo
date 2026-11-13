import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Connect, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteStaticCopy } from "vite-plugin-static-copy";

// Repo sample cases (data/web/<case>/) are served here; anything else under /data and /api
// (the dated exports in $WEB_ROOT/<format>/yyyymm/yyyymmdd/) is proxied to the FastAPI service.
const dataRoot = path.resolve(__dirname, "../data/web");
const dataApi = process.env.DATA_API ?? "http://127.0.0.1:8000";

/** Same rule as services/cache_headers.py: frame payloads and t000/*.json index files only. */
function cacheControlFor(file: string): string | undefined {
  const name = path.basename(file);
  if (name === "manifest.json") return "no-cache";
  const inFrameDir = /^t\d{3}$/.test(path.basename(path.dirname(file)));
  if (name.endsWith(".bin.br") || name.endsWith(".sz3pack") || (name.endsWith(".json") && inFrameDir)) {
    return "public, max-age=31536000, immutable";
  }
  return undefined;
}

function serveData(
  request: Connect.IncomingMessage,
  response: Connect.ServerResponse,
  next: Connect.NextFunction,
): void {
  const relative = decodeURIComponent((request.url ?? "").replace(/^\//, ""));
  const file = path.resolve(dataRoot, relative);
  if (!file.startsWith(dataRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    next();
    return;
  }
  if (file.endsWith(".bin.br")) {
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Encoding", "br");
  } else if (file.endsWith(".json")) {
    response.setHeader("Content-Type", "application/json");
  } else if (file.endsWith(".sz3pack")) {
    response.setHeader("Content-Type", "application/octet-stream");
  }
  const cache = cacheControlFor(file);
  if (cache) response.setHeader("Cache-Control", cache);
  response.end(fs.readFileSync(file));
}

function dataPlugin(): Plugin {
  return {
    name: "serve-external-data",
    configureServer(server) {
      server.middlewares.use("/data", serveData);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/data", serveData);
    },
    closeBundle() {
      fs.cpSync(dataRoot, path.resolve(__dirname, "dist/data"), { recursive: true });
    },
  };
}

// Cesium's Workers / Assets / Widgets / ThirdParty are fetched at runtime from CESIUM_BASE_URL
// (same setup as https://github.com/CesiumGS/cesium-vite-example); only the globe tab uses them.
const cesiumSource = "node_modules/cesium/Build/Cesium";
const cesiumBaseUrl = "cesium";

/**
 * CESIUM_BASE_URL = <vite base>cesium, so `vite build --base /sub/` (or `base` in config) finds the copied
 * assets. A relative base ("./", "" ) stays relative ("./cesium"): Cesium resolves CESIUM_BASE_URL against
 * the page, so a build opened from any directory still finds its own copy.
 */
export function cesiumBaseFor(base: string | undefined): string {
  if (base === undefined) return `/${cesiumBaseUrl}`;
  if (base === "" || base === "./" || base === ".") return `./${cesiumBaseUrl}`;
  return `${base.endsWith("/") ? base : `${base}/`}${cesiumBaseUrl}`;
}

function cesiumBasePlugin(): Plugin {
  return {
    name: "cesium-base-url",
    // `config` sees the merged config, CLI --base included
    config(config) {
      return { define: { CESIUM_BASE_URL: JSON.stringify(cesiumBaseFor(config.base)) } };
    },
  };
}

export default defineConfig({
  plugins: [
    vue(),
    dataPlugin(),
    cesiumBasePlugin(),
    viteStaticCopy({
      targets: ["ThirdParty", "Workers", "Assets", "Widgets"].map((dir) => ({
        src: `${cesiumSource}/${dir}`,
        dest: cesiumBaseUrl,
        rename: { stripBase: 4 },
      })),
    }),
  ],
  publicDir: false,
  assetsInclude: ["**/*.wasm"],
  worker: { format: "es" },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": { target: dataApi, changeOrigin: true },
      "/data": { target: dataApi, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      "/api": { target: dataApi, changeOrigin: true },
      "/data": { target: dataApi, changeOrigin: true },
    },
  },
});
