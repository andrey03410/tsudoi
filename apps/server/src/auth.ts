import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Actor, Invite, InviteAccepted, InviteKind, InvitePreview, IssuedInvite } from "@tsudoi/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";
import type { PrismaClient } from "./db.js";
import { fail } from "./errors.js";

const day = 24 * 60 * 60 * 1000;
const accountInviteLifetime = 7 * day;
const guestInviteLifetime = day;
const guestLifetime = 7 * day;
const accountSessionLifetime = 30 * day;
const cookieName = "tsudoi_session";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const loginPattern = /^[\p{L}\p{N}._-]{3,40}$/u;
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const scryptOptions = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const actorFields = { id: true, displayName: true, role: true } as const;

type AuthStore = Pick<PrismaClient, "actor" | "chat" | "invite" | "membership" | "session">;
type ActorRecord = { id: string; displayName: string; role: string };
type InviteScope = { kind: InviteKind; chatId: string | null };
type InviteParams = { id?: string };

function publicActor(record: ActorRecord, expiresAt: Date | null = null): Actor {
  return { id: record.id, displayName: record.displayName, role: record.role as Actor["role"], expiresAt: expiresAt?.toISOString() ?? null };
}

function loginValue(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 100) return null;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return loginPattern.test(normalized) ? normalized : null;
}

function passwordValue(value: unknown): string | null {
  return typeof value === "string" && value.length >= 8 && value.length <= 256 ? value : null;
}

export function requireCredentials(login: unknown, password: unknown): { login: string; password: string } {
  const normalizedLogin = loginValue(login);
  const validatedPassword = passwordValue(password);
  if (!normalizedLogin) fail(400, "INVALID_LOGIN", "Логин должен содержать от 3 до 40 букв, цифр или символов . _ -.");
  if (!validatedPassword) fail(400, "INVALID_PASSWORD", "Введите пароль длиной от 8 до 256 символов.");
  return { login: normalizedLogin, password: validatedPassword };
}

export function requireDisplayName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 80) fail(400, "INVALID_DISPLAY_NAME", "Введите имя длиной от 1 до 80 символов.");
  return name;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, scryptOptions);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function matchesPassword(password: string, hash: string | null): Promise<boolean> {
  const parts = /^scrypt\$([\da-f]{32})\$([\da-f]{128})$/.exec(hash ?? "");
  const salt = parts ? Buffer.from(parts[1], "hex") : Buffer.alloc(16);
  const expected = parts ? Buffer.from(parts[2], "hex") : Buffer.alloc(64);
  const key = await scryptAsync(password, salt, 64, scryptOptions);
  return timingSafeEqual(key, expected) && Boolean(parts);
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionHash(request: FastifyRequest): string | null {
  const token = request.cookies[cookieName];
  return token && tokenPattern.test(token) ? digest(token) : null;
}

function cookieOptions(context: AppContext) {
  return { httpOnly: true, sameSite: "lax" as const, secure: context.secureCookies, path: "/" };
}

function setSessionCookie(reply: FastifyReply, context: AppContext, token: string, expiresAt: Date) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - context.now().getTime()) / 1000));
  reply.setCookie(cookieName, token, { ...cookieOptions(context), maxAge });
}

export async function getActor(request: FastifyRequest, context: AppContext): Promise<Actor | null> {
  const tokenHash = sessionHash(request);
  if (!tokenHash) return null;
  const now = context.now();
  const session = await context.db.session.findUnique({
    where: { tokenHash },
    select: { expiresAt: true, actor: { select: actorFields } },
  });
  if (!session || session.expiresAt <= now) return null;
  if (session.actor.role !== "guest") return publicActor(session.actor);

  const membership = await context.db.membership.findFirst({
    where: { actorId: session.actor.id, revokedAt: null, expiresAt: { gt: now } },
    select: { expiresAt: true },
  });
  return membership ? publicActor(session.actor, membership.expiresAt) : null;
}

export async function requireActor(request: FastifyRequest, context: AppContext): Promise<Actor> {
  const actor = await getActor(request, context);
  if (!actor) fail(401, "AUTH_REQUIRED", "Войдите в аккаунт или откройте действующее приглашение.");
  return actor;
}

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function unavailableInvite(): never {
  return fail(404, "INVITE_UNAVAILABLE", "Приглашение недоступно. Попросите пригласившего отправить новую ссылку.");
}

function invalidLogin(): never {
  return fail(401, "INVALID_CREDENTIALS", "Проверьте логин и пароль.");
}

function inviteInput(body: Record<string, unknown>): { kind: InviteKind; tokenHash: string } {
  const { kind, token } = body;
  if ((kind !== "account" && kind !== "guest") || typeof token !== "string" || !tokenPattern.test(token)) unavailableInvite();
  return { kind, tokenHash: digest(token) };
}

function inviteView(record: { id: string; expiresAt: Date; revokedAt: Date | null; usedAt: Date | null }, kind: InviteKind, now: Date): Invite {
  let status: Invite["status"] = "active";
  if (record.revokedAt) status = "revoked";
  else if (record.usedAt) status = "used";
  else if (record.expiresAt <= now) status = "expired";
  return { id: record.id, kind, expiresAt: record.expiresAt.toISOString(), status };
}

async function availableInvite(db: AuthStore, entry: { kind: InviteKind; tokenHash: string }, now: Date) {
  const invite = await db.invite.findUnique({
    where: { tokenHash: entry.tokenHash, kind: entry.kind, expiresAt: { gt: now }, usedAt: null, revokedAt: null },
    include: { chat: { select: { id: true, kind: true, title: true } } },
  });
  if (!invite || (entry.kind === "guest" && invite.chat?.kind !== "group")) unavailableInvite();
  return invite;
}

async function canManageInvites(context: AppContext, request: FastifyRequest, scope: InviteScope): Promise<Actor> {
  const actor = await requireActor(request, context);
  if (scope.kind === "account") {
    if (actor.role !== "admin") fail(403, "FORBIDDEN", "Приглашения для регистрации выдаёт администратор.");
    return actor;
  }

  const chat = await context.db.chat.findFirst({
    where: { id: scope.chatId ?? "", ownerId: actor.id, kind: "group" },
    select: { id: true },
  });
  if (!chat) fail(404, "CHAT_UNAVAILABLE", "Группа недоступна.");
  return actor;
}

function registerInviteManagement(app: FastifyInstance, context: AppContext, kind: InviteKind, path: string) {
  const scopeOf = ({ id }: InviteParams): InviteScope => ({ kind, chatId: id ?? null });

  app.get<{ Params: InviteParams }>(path, async (request): Promise<Invite[]> => {
    const scope = scopeOf(request.params);
    await canManageInvites(context, request, scope);
    const records = await context.db.invite.findMany({ where: scope, orderBy: [{ expiresAt: "desc" }, { id: "desc" }] });
    const now = context.now();
    return records.map((record) => inviteView(record, kind, now));
  });

  app.post<{ Params: InviteParams }>(path, async (request, reply): Promise<IssuedInvite> => {
    const scope = scopeOf(request.params);
    const actor = await canManageInvites(context, request, scope);
    const now = context.now();
    const lifetime = kind === "account" ? accountInviteLifetime : guestInviteLifetime;
    const expiresAt = new Date(now.getTime() + lifetime);
    const token = newToken();
    const record = await context.db.invite.create({ data: { ...scope, expiresAt, tokenHash: digest(token), createdById: actor.id } });
    reply.code(201);
    return { invite: inviteView(record, kind, now), token };
  });

  app.delete<{ Params: InviteParams & { inviteId: string } }>(`${path}/:inviteId`, async (request): Promise<Invite> => {
    const scope = scopeOf(request.params);
    await canManageInvites(context, request, scope);
    const where = { ...scope, id: request.params.inviteId };
    const now = context.now();
    return context.db.$transaction(async (db) => {
      await db.invite.updateMany({
        where: { ...where, expiresAt: { gt: now }, revokedAt: null, usedAt: null },
        data: { revokedAt: now },
      });
      const current = await db.invite.findFirst({ where });
      if (!current) unavailableInvite();
      return inviteView(current, kind, now);
    });
  });
}

function attemptLimiter(context: AppContext, maxAttempts: number) {
  const period = 5 * 60 * 1000;
  const attempts = new Map<string, { count: number; until: number }>();
  let cleanAt = 0;

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const now = context.now().getTime();
    if (now >= cleanAt) {
      for (const [ip, entry] of attempts) {
        if (entry.until <= now) attempts.delete(ip);
      }
      cleanAt = now + period;
    }

    const previous = attempts.get(request.ip);
    const entry = previous && previous.until > now ? previous : { count: 0, until: now + period };
    if (entry.count >= maxAttempts || (!previous && attempts.size >= 5000)) {
      reply.header("Retry-After", Math.ceil((entry.until - now) / 1000));
      fail(429, "TOO_MANY_ATTEMPTS", "Слишком много попыток. Попробуйте ещё раз через несколько минут.");
    }
    entry.count += 1;
    attempts.set(request.ip, entry);
  };
}

async function acceptInvite(request: FastifyRequest, reply: FastifyReply, context: AppContext): Promise<InviteAccepted> {
  const body = bodyRecord(request);
  const entry = inviteInput(body);
  const invite = await availableInvite(context.db, entry, context.now());
  const currentActor = await getActor(request, context);
  if (currentActor) {
    if (entry.kind === "guest" && invite.chatId) {
      const membership = await context.db.membership.findFirst({
        where: {
          chatId: invite.chatId, actorId: currentActor.id, revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: context.now() } }],
        },
        select: { chatId: true },
      });
      if (membership) return { actor: currentActor, chatId: membership.chatId };
    }
    fail(409, "SESSION_ACTIVE", "Вы уже вошли. Чтобы принять приглашение, откройте ссылку в приватном окне или другом профиле браузера.");
  }

  const displayName = requireDisplayName(body.displayName);
  const credentials = entry.kind === "account" ? requireCredentials(body.login, body.password) : null;
  const passwordHash = credentials ? await hashPassword(credentials.password) : null;
  const token = newToken();
  const tokenHash = digest(token);

  const accepted = await context.db.$transaction(async (db) => {
    const now = context.now();
    const changed = await db.invite.updateMany({
      where: { id: invite.id, expiresAt: { gt: now }, revokedAt: null, usedAt: null },
      data: { usedAt: now },
    });
    if (!changed.count) unavailableInvite();

    if (credentials && await db.actor.findUnique({ where: { login: credentials.login }, select: { id: true } })) {
      fail(409, "LOGIN_TAKEN", "Этот логин занят. Выберите другой.");
    }
    const actor = await db.actor.create({
      data: { displayName, login: credentials?.login, passwordHash, role: credentials ? "member" : "guest" },
      select: actorFields,
    });

    const expiresAt = new Date(now.getTime() + (credentials ? accountSessionLifetime : guestLifetime));
    const chatId = invite.chatId ?? undefined;
    if (chatId) {
      const lastMessage = await db.message.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
      const lastReadId = lastMessage?.id ?? 0;
      await db.membership.create({ data: { actorId: actor.id, chatId, lastReadId, firstVisibleId: lastReadId + 1, expiresAt } });
    }
    await db.session.create({ data: { tokenHash, expiresAt, actorId: actor.id } });
    return { actor: publicActor(actor, chatId ? expiresAt : null), chatId, expiresAt };
  });

  setSessionCookie(reply, context, token, accepted.expiresAt);
  if (accepted.chatId) context.notify(accepted.chatId);
  return { actor: accepted.actor, chatId: accepted.chatId };
}

export function registerAuthRoutes(app: FastifyInstance, context: AppContext) {
  app.get("/api/me", async (request) => ({ actor: await getActor(request, context) }));

  app.post("/api/login", { preHandler: attemptLimiter(context, 10) }, async (request, reply) => {
    const body = bodyRecord(request);
    const login = loginValue(body.login);
    const password = passwordValue(body.password);
    if (!login || !password) invalidLogin();
    const actor = await context.db.actor.findUnique({ where: { login } });
    if (!await matchesPassword(password, actor?.passwordHash ?? null) || !actor || actor.role === "guest") invalidLogin();

    const token = newToken();
    const expiresAt = new Date(context.now().getTime() + accountSessionLifetime);
    const previousHash = sessionHash(request);
    await context.db.$transaction(async (db) => {
      if (previousHash) await db.session.deleteMany({ where: { tokenHash: previousHash } });
      await db.session.create({ data: { tokenHash: digest(token), actorId: actor.id, expiresAt } });
    });
    if (previousHash) context.notify();
    setSessionCookie(reply, context, token, expiresAt);
    return { actor: publicActor(actor) };
  });

  app.post("/api/logout", async (request, reply) => {
    const tokenHash = sessionHash(request);
    if (tokenHash) {
      await context.db.session.deleteMany({ where: { tokenHash } });
      context.notify();
    }
    reply.clearCookie(cookieName, cookieOptions(context));
    return { ok: true };
  });

  app.get("/api/users", async (request): Promise<Actor[]> => {
    const actor = await requireActor(request, context);
    if (actor.role === "guest") fail(403, "FORBIDDEN", "Каталог доступен постоянным участникам.");
    const users = await context.db.actor.findMany({
      where: { role: { in: ["admin", "member"] } },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      select: actorFields,
    });
    return users.map((user) => publicActor(user));
  });

  registerInviteManagement(app, context, "account", "/api/invites/account");
  registerInviteManagement(app, context, "guest", "/api/chats/:id/invites");

  app.post("/api/invites/preview", { preHandler: attemptLimiter(context, 30) }, async (request): Promise<InvitePreview> => {
    const entry = inviteInput(bodyRecord(request));
    const invite = await availableInvite(context.db, entry, context.now());
    return { kind: entry.kind, expiresAt: invite.expiresAt.toISOString(), chatId: invite.chat?.id, title: invite.chat?.title ?? undefined };
  });

  app.post("/api/invites/accept", { preHandler: attemptLimiter(context, 10) }, (request, reply) => acceptInvite(request, reply, context));
}
