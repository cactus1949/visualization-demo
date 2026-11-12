import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Connect, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

const dataRoot = path.resolve(__dirname, "../data/web");

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
  server: { host: "0.0.0.0" },
});
