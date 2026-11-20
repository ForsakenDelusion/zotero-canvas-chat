import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./ui", import.meta.url)),
  server: { fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] } },
  esbuild: { jsx: "automatic" },
});
