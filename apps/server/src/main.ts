import { resolve } from "node:path";
import { createApp } from "./app.js";

const app = await createApp({
  storageDir: process.env.TSUDOI_STORAGE_DIR ?? "storage",
  secureCookies: process.env.TSUDOI_SECURE_COOKIES === "1",
  origin: process.env.TSUDOI_ORIGIN,
  trustProxy: process.env.TSUDOI_TRUST_PROXY?.split(",").map((range) => range.trim()).filter(Boolean),
  webRoot: process.argv.includes("--serve-web") ? resolve(import.meta.dirname, "../../web/dist") : undefined,
  logger: true,
});

await app.listen({
  host: process.env.TSUDOI_HOST ?? "127.0.0.1",
  port: Number(process.env.TSUDOI_PORT ?? "8791"),
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().catch((error) => {
      app.log.error(error, "Shutdown failed");
      process.exitCode = 1;
    });
  });
}
