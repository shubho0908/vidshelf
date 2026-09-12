import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// VITE_WEB_BUILD=1 (npm run build:web): the baked sync key module is swapped
// for an empty one - the secret cannot appear in the public bundle, no
// reliance on minifier dead-code elimination.
const isWebBuild = process.env.VITE_WEB_BUILD === "1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: isWebBuild
      ? [{ find: /^\.\/syncKey\.baked$/, replacement: fileURLToPath(new URL("./src/syncKey.none.ts", import.meta.url)) }]
      : [],
  },
  build: {
    target: "es2018",
    chunkSizeWarningLimit: 900,
    rollupOptions: isWebBuild
      ? { input: { landing: "landing.html", app: "app.html" } }
      : undefined,
  },
});
