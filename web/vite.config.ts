import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Connect, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

// Repo sample cases (data/web/<case>/) are served here; anything else under /data and /api
// (the dated exports in $WEB_ROOT/<format>/yyyymm/yyyymmdd/) is proxied to the FastAPI service.
const dataRoot = path.resolve(__dirname, "../data/web");
const dataApi = process.env.DATA_API ?? "http://127.0.0.1:8000";

function cacheControlFor(file: string): string | undefined {
  const name = path.basename(file);
  if (name === "manifest.json") return "no-cache";
  if (name.endsWith(".bin.br") || name.endsWith(".sz3pack") || name.endsWith(".json")) {
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

export default defineConfig({
  plugins: [vue(), dataPlugin()],
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
