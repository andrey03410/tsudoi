import { resolve } from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "apps/server/prisma/schema.prisma",
  migrations: { path: "apps/server/prisma/migrations" },
  datasource: {
    url: `file:${resolve(process.env.TSUDOI_STORAGE_DIR ?? "storage", "tsudoi.sqlite")}`,
  },
});
