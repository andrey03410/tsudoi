import { readFileSync } from "node:fs";
import { hashPassword } from "../apps/server/src/auth.js";
import { openDatabase } from "../apps/server/src/db.js";

const login = process.argv[2]?.trim().toLowerCase();
const role = process.argv[3];
const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
if (!login || !/^[a-z0-9._-]{3,40}$/.test(login) || !password || password.length > 256 || (role !== "admin" && role !== "member")) {
  throw new Error("Expected a login, admin or member role, and a password on stdin");
}
const db = await openDatabase(process.env.TSUDOI_STORAGE_DIR ?? "storage");
try {
  const thatAccount = await db.actor.findUnique({ where: { login } });
  if (thatAccount && thatAccount.role !== role) throw new Error("Account already exists with a different role");
  if (!thatAccount) {
    await db.actor.create({ data: { login, displayName: login, role, passwordHash: await hashPassword(password) } });
  }
  console.log(`Account ready: ${login}`);
} finally {
  await db.$disconnect();
}
