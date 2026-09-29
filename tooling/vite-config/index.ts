import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type UserConfig } from "vite";

const faviconPath = fileURLToPath(new URL("./favicon.svg", import.meta.url));

export function sharedFavicon(): Plugin {
  return {
    name: "krynodes:favicon",
    configureServer(server) {
      server.middlewares.use("/favicon.svg", (_request, response) => {
        response.setHeader("Content-Type", "image/svg+xml");
        response.end(readFileSync(faviconPath));
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "favicon.svg",
        source: readFileSync(faviconPath, "utf8"),
      });
    },
  };
}

export function reactApp(config: UserConfig = {}) {
  const { plugins = [], ...rest } = config;
  return defineConfig({
    plugins: [react(), sharedFavicon(), ...plugins],
    ...rest,
  });
}
