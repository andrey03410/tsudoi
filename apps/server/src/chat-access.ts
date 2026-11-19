import type { Prisma } from "./db.js";
import { fail } from "./errors.js";

export function activeMembership(now: Date) {
  return { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

export async function membership(tx: Prisma.TransactionClient, chatId: string, actorId: string, now: Date) {
  const row = await tx.membership.findFirst({
    where: { chatId, actorId, ...activeMembership(now) },
    include: { chat: true },
  });
  if (!row) fail(404, "chat_unavailable", "Чат недоступен.");
  return row;
}
