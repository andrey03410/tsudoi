import { stdin, stderr, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Actor } from "@tsudoi/contracts";
import { hashPassword, requireCredentials, requireDisplayName } from "./auth.js";
import { openDatabase, type PrismaClient } from "./db.js";
import { ApiError, fail } from "./errors.js";

export async function bootstrapAdmin(
  db: PrismaClient,
  input: { login: string; displayName: string; password: string },
): Promise<Actor> {
  const { login, password } = requireCredentials(input.login, input.password);
  const displayName = requireDisplayName(input.displayName);
  const passwordHash = await hashPassword(password);
  return db.$transaction(async (tx) => {
    const existing = await tx.actor.findFirst({ where: { role: "admin" }, select: { id: true } });
    if (existing) fail(409, "ADMIN_EXISTS", "Администратор уже создан.");
    const loginOwner = await tx.actor.findUnique({ where: { login }, select: { id: true } });
    if (loginOwner) fail(409, "LOGIN_TAKEN", "Этот логин занят. Выберите другой.");
    const { id } = await tx.actor.create({ data: { login, displayName, passwordHash, role: "admin" }, select: { id: true } });
    return { id, displayName, role: "admin", expiresAt: null };
  });
}

async function readPassword(): Promise<string> {
  stdin.setEncoding("utf8");
  if (!stdin.isTTY) {
    let password = "";
    for await (const chunk of stdin) {
      password += String(chunk);
      if (password.length > 258) fail(400, "INVALID_PASSWORD", "Введите пароль длиной от 8 до 256 символов.");
    }
    return password.replace(/\r?\n$/, "");
  }

  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const prompt = createInterface({ input: stdin, output, terminal: true });
  const controller = new AbortController();
  prompt.once("SIGINT", () => controller.abort());
  prompt.once("close", () => controller.abort());
  stderr.write("Пароль: ");
  try {
    return await prompt.question("", { signal: controller.signal });
  } finally {
    prompt.close();
    stderr.write("\n");
  }
}

async function runAdminCommand() {
  try {
    const { values } = parseArgs({ options: { login: { type: "string" }, "display-name": { type: "string" } } });
    const { login, "display-name": displayName } = values;
    if (!login || !displayName) fail(400, "INVALID_ADMIN_ARGS", "Укажите --login и --display-name. Пароль вводится отдельно.");
    const password = await readPassword();
    const db = await openDatabase(process.env.TSUDOI_STORAGE_DIR ?? "storage");
    try {
      await bootstrapAdmin(db, { login, displayName, password });
      stdout.write("Администратор создан.\n");
    } finally {
      await db.$disconnect();
    }
  } catch (error) {
    stderr.write(`${error instanceof ApiError ? error.message : "Не удалось создать администратора."}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runAdminCommand();
}
