import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

const app = Fastify({ logger: true });
app.get("/health", async () => ({ status: "ok" }));

if (process.argv.includes("--serve-web")) {
  await app.register(fastifyStatic, {
    root: resolve(import.meta.dirname, "../../web/dist"),
  });
}

await app.listen({
  host: process.env.TSUDOI_HOST ?? "127.0.0.1",
  port: Number(process.env.TSUDOI_PORT ?? "8791"),
});
