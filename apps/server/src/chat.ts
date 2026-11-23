import { kanameEnabled } from "@kaname/service-client";
import type { Actor, ChatKind, ChatSummary, Message, MessagePage, Reaction } from "@tsudoi/contracts";
import type { FastifyInstance } from "fastify";
import type { SiteActor } from "./kaname.js";
import { requireActor } from "./auth.js";
import { activeMembership, membership } from "./chat-access.js";
import type { AppContext } from "./context.js";
import type { Prisma } from "./db.js";
import { fail } from "./errors.js";
import { registerMediaRoutes } from "./media.js";

const PAGE_SIZE = 40;
const STICKERS = new Set(["wave", "cheer", "hearts", "tea", "giggle", "sleepy"]);
const REACTIONS = new Set(["👍", "❤️", "😂", "🔥", "😮", "😢"]);
const chatUrl = "/api/chats/:id";
const attachmentFields = { id: true, name: true, size: true, mime: true } as const;
const actorFields = { id: true, displayName: true, role: true } as const;
const messageInclude = {
  author: { select: actorFields },
  attachments: { select: attachmentFields, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
  reactions: { select: { actorId: true, emoji: true, actor: { select: { role: true } } }, orderBy: { emoji: "asc" } },
} satisfies Prisma.MessageInclude;
type Tx = Prisma.TransactionClient;
type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;
type ChatMember = Awaited<ReturnType<typeof membership>>;
type ChatRoute = { Params: { id: string }; Body: Record<string, unknown> };

function invalid(): never {
  return fail(400, "invalid_input", "Проверьте данные и попробуйте ещё раз.");
}

function stringValue(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid();
  return value.trim();
}

function stringIds(value: unknown, max?: number): string[] {
  if (!Array.isArray(value) || (max !== undefined && value.length > max)) invalid();
  const ids = value.map(id => stringValue(id, 128));
  if (new Set(ids).size !== ids.length) invalid();
  return ids;
}

function cursor(value: unknown) {
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value) || Number(value) > 2147483647) invalid();
  return Number(value);
}

function serializeActor(actor: MessageRow["author"], expiresAt: Date | null = null): Actor {
  return { id: actor.id, displayName: actor.displayName, role: actor.role as Actor["role"], expiresAt: expiresAt?.toISOString() ?? null };
}

function serializeMessage(row: MessageRow, actorId: string): Message {
  const reactions = new Map<string, Reaction>();
  for (const { emoji, actorId: voter, actor } of row.reactions) {
    const reaction = reactions.get(emoji) ?? { emoji, count: 0, mine: false, guestCount: 0 };
    reaction.count++;
    if (actor.role === "guest") reaction.guestCount++;
    reaction.mine ||= voter === actorId;
    reactions.set(emoji, reaction);
  }
  return {
    id: row.id, clientId: row.clientId, text: row.text, stickerId: row.stickerId, createdAt: row.createdAt.toISOString(),
    author: serializeActor(row.author), attachments: row.attachments, reactions: [...reactions.values()],
  };
}

async function summarizeChat(tx: Tx, member: ChatMember) {
  const { chat, chatId, actorId, firstVisibleId, lastReadId } = member;
  const latest = await tx.message.findFirst({
    where: { chatId, id: { gte: firstVisibleId } }, orderBy: { id: "desc" },
    select: { id: true, text: true, stickerId: true, createdAt: true, attachments: { take: 1, select: { name: true } } },
  });
  const unreadCount = await tx.message.count({
    where: { chatId, authorId: { not: actorId }, id: { gt: lastReadId, gte: firstVisibleId } },
  });
  let title = chat.title ?? "";
  if (chat.kind === "direct") {
    const peer = await tx.membership.findFirstOrThrow({
      where: { chatId, actorId: { not: actorId } }, select: { actor: { select: { displayName: true } } },
    });
    title = peer.actor.displayName;
  }
  const summary: ChatSummary = {
    id: chatId, kind: chat.kind as ChatKind, title, isOwner: chat.kind === "group" && chat.ownerId === actorId,
    preview: latest ? (latest.text?.slice(0, 140) ?? (latest.stickerId ? "Стикер" : latest.attachments[0]?.name ?? null)) : null,
    lastMessageAt: latest?.createdAt.toISOString() ?? null, unreadCount,
  };
  return { summary, activityAt: (latest?.createdAt ?? chat.createdAt).getTime(), latestId: latest?.id ?? 0 };
}

function requirePermanent(actor: Actor) {
  if (actor.role === "guest") fail(403, "forbidden", "Действие доступно постоянным участникам.");
}

function requireOwner(member: ChatMember) {
  if (member.chat.kind !== "group" || member.chat.ownerId !== member.actorId) {
    fail(403, "forbidden", "Составом группы управляет её владелец.");
  }
}

function visibleMessage(tx: Tx, member: ChatMember, id: number) {
  return tx.message.findFirst({
    where: { chatId: member.chatId, id: { equals: id, gte: member.firstVisibleId } },
    include: messageInclude,
  }).then(row => row ?? fail(404, "message_unavailable", "Сообщение недоступно."));
}

export function registerChatRoutes(app: FastifyInstance, context: AppContext) {
  registerMediaRoutes(app, context);
  app.get("/api/chats", async request => {
    const actor = await requireActor(request, context);
    return context.db.$transaction(async tx => {
      const rows = await tx.membership.findMany({
        where: { actorId: actor.id, ...activeMembership(context.now()) },
        include: { chat: true },
      });
      const chats = await Promise.all(rows.map(row => summarizeChat(tx, row)));
      chats.sort((a, b) => b.activityAt - a.activityAt || b.latestId - a.latestId || a.summary.id.localeCompare(b.summary.id));
      return chats.map(chat => chat.summary);
    });
  });

  app.get<ChatRoute>(chatUrl, async request => {
    const actor = await requireActor(request, context);
    return context.db.$transaction(async tx => {
      const now = context.now();
      const member = await membership(tx, request.params.id, actor.id, now);
      const members = await tx.membership.findMany({
        where: { chatId: member.chatId, ...activeMembership(now) },
        include: { actor: { select: actorFields } }, orderBy: { actor: { displayName: "asc" } },
      });
      const { summary } = await summarizeChat(tx, member);
      return { ...summary, members: members.map(m => serializeActor(m.actor, m.expiresAt)) };
    });
  });

  app.post<ChatRoute>("/api/chats/direct", async request => {
    const actor = await requireActor(request, context);
    requirePermanent(actor);
    const userId = stringValue(request.body?.userId, 128);
    if (actor.id === userId) invalid();
    const ids = [actor.id, userId].sort();
    const directKey = JSON.stringify(ids);
    const {id, created} = await context.db.$transaction(async tx => {
      const existing = await tx.chat.findUnique({ where: { directKey }, select: { id: true } });
      if (existing) return { id: existing.id, created: false };
      if (!await tx.actor.count({ where: { id: userId, role: { not: "guest" }, ...(kanameEnabled() ? { kanameIssuer: process.env.KANAME_OIDC_ISSUER!, kanameSuspended: false } : {}) } })) invalid();
      const now = context.now();
      const chat = await tx.chat.create({
        data: { kind: "direct", directKey, ownerId: actor.id, createdAt: now, updatedAt: now,
          memberships: { create: ids.map(actorId => ({ actorId })) } },
      });
      return { id: chat.id, created: true };
    });
    if (created) context.notify(id);
    return { id };
  });

  app.post<ChatRoute>("/api/chats/group", async request => {
    const actor = await requireActor(request, context);
    requirePermanent(actor);
    const title = stringValue(request.body?.title, 160);
    const ids = [...new Set([actor.id, ...stringIds(request.body?.memberIds ?? [])])];
    const chat = await context.db.$transaction(async tx => {
      const limit = (actor as SiteActor).grant?.limits.groups;
      if (limit != null && await tx.chat.count({where:{ownerId:actor.id, kind:"group"}}) >= limit)
        fail(409, "group_limit", "Достигнут лимит своих групп.");
      const count = await tx.actor.count({ where: { id: { in: ids }, role: { not: "guest" }, ...(kanameEnabled() ? { kanameIssuer: process.env.KANAME_OIDC_ISSUER!, kanameSuspended: false } : {}) } });
      if (count !== ids.length) invalid();
      const now = context.now();
      return tx.chat.create({ data: { kind: "group", title, ownerId: actor.id, createdAt: now, updatedAt: now,
        memberships: { create: ids.map(actorId => ({ actorId })) } }, select: { id: true } });
    });
    context.notify(chat.id);
    return chat;
  });

  app.post<ChatRoute>(chatUrl + "/members", async request => {
    const actor = await requireActor(request, context);
    const chatId = request.params.id;
    const actorId = stringValue(request.body?.actorId, 128);
    const changed = await context.db.$transaction(async tx => {
      requireOwner(await membership(tx, chatId, actor.id, context.now()));
      if (!await tx.actor.count({ where: { id: actorId, role: { not: "guest" }, ...(kanameEnabled() ? { kanameIssuer: process.env.KANAME_OIDC_ISSUER!, kanameSuspended: false } : {}) } })) invalid();
      const where = { chatId_actorId: { chatId, actorId } };
      const existing = await tx.membership.findUnique({ where });
      if (existing && !existing.revokedAt) return false;
      await tx.membership.upsert({ where, create: { actorId, chatId }, update: { revokedAt: null } });
      return true;
    });
    if (changed) context.notify(chatId);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; actorId: string } }>(chatUrl + "/members/:actorId", async request => {
    const actor = await requireActor(request, context);
    const { id: chatId, actorId } = request.params;
    const changed = await context.db.$transaction(async tx => {
      const now = context.now();
      requireOwner(await membership(tx, chatId, actor.id, now));
      if (actorId === actor.id) invalid();
      return tx.membership.updateMany({ where: { chatId, actorId, revokedAt: null }, data: { revokedAt: now } });
    });
    if (changed.count) context.notify(chatId, [actorId]);
    return { ok: true };
  });

  app.get<ChatRoute & { Querystring: { before?: string } }>(chatUrl + "/messages", async request => {
    const actor = await requireActor(request, context);
    const chatId = request.params.id;
    const before = request.query.before === undefined ? undefined : cursor(request.query.before);
    return context.db.$transaction(async tx => {
      const member = await membership(tx, chatId, actor.id, context.now());
      const where = { chatId, id: { gte: member.firstVisibleId, lt: before } };
      const rows = await tx.message.findMany({ where, include: messageInclude, orderBy: { id: "desc" }, take: PAGE_SIZE + 1 });
      const latest = await tx.chatEvent.findFirst({
        where: { chatId, messageId: { gte: member.firstVisibleId } }, orderBy: { id: "desc" }, select: { id: true },
      });
      return { messages: rows.slice(0, PAGE_SIZE).reverse().map(row => serializeMessage(row, actor.id)),
        hasMore: rows.length > PAGE_SIZE, cursor: latest?.id ?? 0 } satisfies MessagePage;
    });
  });

  app.get<ChatRoute & { Querystring: { after?: string } }>(chatUrl + "/changes", async request => {
    const actor = await requireActor(request, context);
    const chatId = request.params.id;
    const after = cursor(request.query.after ?? "0");
    return context.db.$transaction(async tx => {
      const member = await membership(tx, chatId, actor.id, context.now());
      const events = await tx.chatEvent.findMany({
        where: { chatId, id: { gt: after }, messageId: { gte: member.firstVisibleId } },
        select: { id: true, messageId: true }, orderBy: { id: "asc" }, take: PAGE_SIZE + 1,
      });
      const page = events.slice(0, PAGE_SIZE);
      const rows = await tx.message.findMany({
        where: { chatId, id: { in: [...new Set(page.map(e => e.messageId))] } },
        include: messageInclude, orderBy: { id: "asc" },
      });
      return { messages: rows.map(row => serializeMessage(row, actor.id)), hasMore: events.length > PAGE_SIZE,
        cursor: page.at(-1)?.id ?? after } satisfies MessagePage;
    });
  });

  app.post<ChatRoute>(chatUrl + "/messages", async request => {
    const actor = await requireActor(request, context);
    const chatId = request.params.id;
    const body = request.body;
    const clientId = stringValue(body?.clientId, 128);
    const text = body.text == null || body.text === "" ? null : stringValue(body.text, 16000);
    const stickerId = body.stickerId == null ? null : stringValue(body.stickerId, 128);
    const attachmentIds = stringIds(body.attachmentIds ?? [], 5);
    if (kanameEnabled() && actor.role === "guest" && (stickerId || attachmentIds.length)) fail(403,"guest_text","Гостю доступны только текстовые сообщения.");
    if (stickerId && (!STICKERS.has(stickerId) || text || attachmentIds.length)) invalid();
    if (!text && !stickerId && !attachmentIds.length) invalid();
    const { row, created } = await context.db.$transaction(async tx => {
      const now = context.now();
      const member = await membership(tx, chatId, actor.id, now);
      const existing = await tx.message.findUnique({ where: { chatId_authorId_clientId: { chatId, authorId: actor.id, clientId } }, include: messageInclude });
      if (existing) {
        if (existing.id < member.firstVisibleId) fail(404, "message_unavailable", "Сообщение недоступно.");
        return { row: existing, created: false };
      }
      const message = await tx.message.create({ data: { chatId, authorId: actor.id, clientId, text, stickerId, createdAt: now } });
      if (attachmentIds.length) {
        const updated = await tx.attachment.updateMany({ where: {
          chatId, uploadedById: actor.id, id: { in: attachmentIds }, messageId: null,
        }, data: { messageId: message.id } });
        if (updated.count !== attachmentIds.length) fail(400, "invalid_attachment", "Выберите вложения ещё раз.");
      }
      await tx.chatEvent.create({ data: { chatId, messageId: message.id, createdAt: now } });
      await tx.chat.update({ where: { id: chatId }, data: { updatedAt: now } });
      const row = await tx.message.findUniqueOrThrow({ where: { id: message.id }, include: messageInclude });
      return { row, created: true };
    });
    if (created) context.notify(chatId);
    return serializeMessage(row, actor.id);
  });

  app.post<ChatRoute>(chatUrl + "/read", async request => {
    const actor = await requireActor(request, context);
    const chatId = request.params.id;
    const id = request.body?.messageId;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > 2147483647) invalid();
    const changed = await context.db.$transaction(async tx => {
      const member = await membership(tx, chatId, actor.id, context.now());
      if (!await tx.message.count({ where: { chatId, id: { equals: id, gte: member.firstVisibleId } } })) {
        fail(404, "message_unavailable", "Сообщение недоступно.");
      }
      return tx.membership.updateMany({ where: { chatId, actorId: actor.id, lastReadId: { lt: id } }, data: { lastReadId: id } });
    });
    if (changed.count) context.notify(chatId);
    return { ok: true };
  });

  app.put<{ Params: { id: string; messageId: string }; Body: Record<string, unknown> }>(chatUrl + "/messages/:messageId/reactions", async request => {
    const actor = await requireActor(request, context);
    if (kanameEnabled() && actor.role === "guest") fail(403, "guest_text", "Гостям доступна текстовая переписка.");
    const chatId = request.params.id;
    const messageId = cursor(request.params.messageId);
    const emoji = request.body?.emoji;
    const active = request.body?.active;
    if (typeof active !== "boolean" || typeof emoji !== "string" || !REACTIONS.has(emoji)) invalid();
    const { row, changed } = await context.db.$transaction(async tx => {
      const now = context.now();
      const member = await membership(tx, chatId, actor.id, now);
      const message = await visibleMessage(tx, member, messageId);
      const key = { messageId, actorId: actor.id, emoji };
      const present = message.reactions.some(r => r.actorId === actor.id && r.emoji === emoji);
      if (present === active) return { row: message, changed: false };
      if (active) await tx.reaction.create({ data: key });
      else await tx.reaction.delete({ where: { messageId_actorId_emoji: key } });
      await tx.chatEvent.create({ data: { chatId, messageId, createdAt: now } });
      return { row: await visibleMessage(tx, member, messageId), changed: true };
    });
    if (changed) context.notify(chatId);
    return serializeMessage(row, actor.id);
  });
}
