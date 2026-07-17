import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = Number(process.env.PORT ?? 8787);
const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiTarget = `http://127.0.0.1:${apiPort}`;
const reactPackages = ["/react/", "/react-dom/", "/scheduler/"];
const playerPackages = [
  "/video.js/",
  "/@videojs/",
  "/@babel/runtime/",
  "/aes-decrypter/",
  "/global/",
  "/m3u8-parser/",
  "/mpd-parser/",
  "/mux.js/",
  "/safe-json-parse/",
  "/url-toolkit/",
  "/videojs-vtt.js/"
];

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, "/");
          if (playerPackages.some((name) => normalized.includes(`/node_modules${name}`))) return "player";
          if (reactPackages.some((name) => normalized.includes(`/node_modules${name}`))) return "react";
          if (normalized.includes("/node_modules/lucide-react/")) return "icons";
          if (normalized.includes("/node_modules/")) return "vendor";
        }
      }
    }
  },
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": apiTarget,
      "/image": apiTarget,
      "/stream": apiTarget,
      "/media": apiTarget,
      "/hls": apiTarget,
      "/dav": apiTarget
    }
  }
});
