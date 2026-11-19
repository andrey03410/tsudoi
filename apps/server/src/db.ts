import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { PrismaClient } from "./generated/prisma/client.js";
import { sqliteAdapter } from "./sqlite.js";

export type { Prisma, PrismaClient } from "./generated/prisma/client.js";

const migrationsDir = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));

export async function openDatabase(storageDir: string): Promise<PrismaClient> {
  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const path = resolve(storageDir, "tsudoi.sqlite");
  migrate(path);
  const db = new PrismaClient({ adapter: sqliteAdapter(`file:${path}`) });
  await db.$connect();
  return db;
}

function migrate(path: string) {
  const db = new Database(path, { timeout: 5000 });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const migrations = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    db.transaction(() => {
      const version = Number(db.pragma("user_version", { simple: true }));
      if (version > migrations.length) {
        throw new Error("The database requires a newer version of Tsudoi.");
      }
      for (let index = version; index < migrations.length; index++) {
        db.exec(readFileSync(resolve(migrationsDir, migrations[index], "migration.sql"), "utf8"));
        db.pragma(`user_version = ${index + 1}`);
      }
    }).immediate();
  } finally {
    db.close();
  }
}
