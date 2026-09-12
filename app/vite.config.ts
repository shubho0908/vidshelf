import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// VITE_WEB_BUILD=1 (npm run build:web): emits the public MPA (landing + app).
// No sync key exists in source at all - every build is keyless by construction.
const isWebBuild = process.env.VITE_WEB_BUILD === "1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    target: "es2018",
    chunkSizeWarningLimit: 900,
    rollupOptions: isWebBuild
      ? { input: { landing: "landing.html", app: "app.html" } }
      : undefined,
  },
});
