import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const root = import.meta.dirname;
const repoRoot = resolve(root, "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "TSUDOI_");

  return {
    root,
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: Number(env.TSUDOI_WEB_PORT ?? "5175"),
      strictPort: true,
      proxy: {
        "/health": `http://127.0.0.1:${env.TSUDOI_PORT ?? "8791"}`,
      },
    },
  };
});
