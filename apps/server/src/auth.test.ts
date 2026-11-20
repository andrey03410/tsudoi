import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { IssuedInvite } from "@tsudoi/contracts";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { bootstrapAdmin } from "./admin.js";
import { hashPassword } from "./auth.js";
import { openDatabase } from "./db.js";

const adminCredentials = {
  login: "Founder",
  displayName: "Основатель",
  password: "founder's test password",
};
const memberCredentials = { login: "friend", displayName: "Друг", password: "friend's test password" };
const start = "2026-11-19T08:00:00.000Z";
const day = 24 * 60 * 60 * 1000;

async function fixture(t: TestContext) {
  const storageDir = await mkdtemp(join(tmpdir(), "tsudoi-auth-"));
  let time = new Date(start).getTime();
  const resources: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    try {
      await Promise.all(resources.map((close) => close()));
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
  const db = await openDatabase(storageDir);
  resources.push(() => db.$disconnect());
  const admin = await bootstrapAdmin(db, adminCredentials);
  const app = await createApp({ storageDir, now: () => new Date(time), secureCookies: true });
  resources.push(() => app.close());
  return { app, db, admin, advance(ms: number) { time += ms; } };
}

async function login(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST", url: "/api/login", payload: { ...adminCredentials, login: " founder " },
  });
  assert.equal(response.statusCode, 200, response.body);
  const header = response.headers["set-cookie"];
  assert.equal(typeof header, "string");
  return String(header);
}

async function issueInvite(app: FastifyInstance, url: string, cookie: string) {
  const response = await app.inject({ method: "POST", url, headers: { cookie } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json<IssuedInvite>();
}

test("bootstraps one persistent administrator and invalidates their signed session on logout", async (t) => {
  const { app, db, admin } = await fixture(t);
  await assert.rejects(() => bootstrapAdmin(db, { ...adminCredentials, login: "another" }));
  const cookie = await login(app);
  assert.match(cookie, /; HttpOnly/i);
  assert.match(cookie, /; SameSite=Lax/i);
  assert.match(cookie, /; Secure/i);
  const session = cookie.split(";", 1)[0];
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: session } })).json(), { actor: admin });

  const storedActor = await db.actor.findUniqueOrThrow({ where: { id: admin.id } });
  assert.notEqual(storedActor.passwordHash, adminCredentials.password);
  assert.equal(await db.session.count(), 1);
  const storedSession = await db.session.findFirstOrThrow();
  assert.ok(!session.includes(storedSession.tokenHash));

  const logout = await app.inject({ method: "POST", url: "/api/logout", headers: { cookie: session } });
  assert.deepEqual(logout.json(), { ok: true });
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: session } })).json(), { actor: null });
});

test("an account link stays active through preview and a duplicate login, then creates one account", async (t) => {
  const { app, db } = await fixture(t);
  const cookie = (await login(app)).split(";", 1)[0];
  const { invite, token } = await issueInvite(app, "/api/invites/account", cookie);
  assert.equal(invite.expiresAt, "2026-11-26T08:00:00.000Z");

  const entry = { kind: "account", token };
  const preview = await app.inject({ method: "POST", url: "/api/invites/preview", payload: entry });
  assert.deepEqual(preview.json(), { kind: "account", expiresAt: invite.expiresAt });
  const duplicateLogin = await app.inject({
    method: "POST", url: "/api/invites/accept", payload: { ...entry, ...memberCredentials, login: "FOUNDER" },
  });
  assert.equal(duplicateLogin.statusCode, 409);
  const stored = await db.invite.findUniqueOrThrow({ where: { id: invite.id } });
  assert.equal(stored.usedAt, null);
  assert.notEqual(stored.tokenHash, token);

  const responses = await Promise.all([
    app.inject({ method: "POST", url: "/api/invites/accept", payload: { ...entry, ...memberCredentials } }),
    app.inject({ method: "POST", url: "/api/invites/accept", payload: { ...entry, ...memberCredentials, login: "someone" } }),
  ]);
  assert.deepEqual(responses.map(({ statusCode }) => statusCode).sort(), [200, 404]);
  const accepted = responses.find(({ statusCode }) => statusCode === 200)!;
  const session = String(accepted.headers["set-cookie"]).split(";", 1)[0];
  assert.equal(accepted.json().actor.role, "member");
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: session } })).json(), accepted.json());
  const listed = await app.inject({ method: "GET", url: "/api/invites/account", headers: { cookie } });
  assert.deepEqual(listed.json(), [{ ...invite, status: "used" }]);
  const revokeUsed = await app.inject({ method: "DELETE", url: `/api/invites/account/${invite.id}`, headers: { cookie } });
  assert.deepEqual(revokeUsed.json(), { ...invite, status: "used" });
  assert.equal(await db.actor.count(), 2);
  const registered = await db.actor.findUniqueOrThrow({ where: { id: accepted.json().actor.id } });
  const signedIn = await app.inject({ method: "POST", url: "/api/login", payload: { login: registered.login, password: memberCredentials.password } });
  assert.deepEqual(signedIn.json(), accepted.json());
});

test("revoked and expired account invitations have the same public failure", async (t) => {
  const { app, advance } = await fixture(t);
  const cookie = (await login(app)).split(";", 1)[0];
  const revoked = await issueInvite(app, "/api/invites/account", cookie);
  const expired = await issueInvite(app, "/api/invites/account", cookie);
  const revoke = await app.inject({ method: "DELETE", url: `/api/invites/account/${revoked.invite.id}`, headers: { cookie } });
  assert.deepEqual(revoke.json(), { ...revoked.invite, status: "revoked" });

  advance(7 * day);
  const listed = await app.inject({ method: "GET", url: "/api/invites/account", headers: { cookie } });
  assert.deepEqual(listed.json().map(({ status }: { status: string }) => status).sort(), ["expired", "revoked"]);
  const [revokedResponse, expiredResponse] = await Promise.all([revoked, expired].map(({ token }) => app.inject({
    method: "POST", url: "/api/invites/preview", payload: { kind: "account", token },
  })));
  assert.equal(revokedResponse.statusCode, 404);
  assert.deepEqual(revokedResponse.json(), expiredResponse.json());
});

test("guest acceptance preserves a signed-in group member and spends the link once for anonymous visitors", async (t) => {
  const { app, db, admin } = await fixture(t);
  const adminCookie = (await login(app)).split(";", 1)[0];
  const chat = await db.chat.create({ data: { kind: "group", ownerId: admin.id, title: "Встреча" } });
  await db.membership.create({ data: { actorId: admin.id, chatId: chat.id } });
  const message = await db.message.create({
    data: { chatId: chat.id, authorId: admin.id, clientId: "pre-guest", text: "Закрытое сообщение" },
  });
  const { invite, token } = await issueInvite(app, `/api/chats/${chat.id}/invites`, adminCookie);
  assert.equal(invite.expiresAt, "2026-11-20T08:00:00.000Z");
  const entry = { kind: "guest", token };
  const preview = await app.inject({ method: "POST", url: "/api/invites/preview", payload: entry });
  assert.deepEqual(preview.json(), { kind: "guest", expiresAt: invite.expiresAt, chatId: chat.id, title: chat.title });

  const existingMember = await app.inject({ method: "POST", url: "/api/invites/accept", headers: { cookie: adminCookie }, payload: entry });
  assert.deepEqual(existingMember.json(), { actor: admin, chatId: chat.id });
  assert.equal(existingMember.headers["set-cookie"], undefined);
  const responses = await Promise.all(["Гость 1", "Гость 2"].map((displayName) => app.inject({
    method: "POST", url: "/api/invites/accept", payload: { ...entry, displayName },
  })));
  assert.deepEqual(responses.map(({ statusCode }) => statusCode).sort(), [200, 404]);
  const accepted = responses.find(({ statusCode }) => statusCode === 200)!;
  const { actor } = accepted.json();
  assert.equal(actor.role, "guest");
  assert.equal(actor.expiresAt, "2026-11-26T08:00:00.000Z");
  const member = await db.membership.findUniqueOrThrow({ where: { chatId_actorId: { chatId: chat.id, actorId: actor.id } } });
  assert.equal(member.firstVisibleId, message.id + 1);
  const cookie = String(accepted.headers["set-cookie"]).split(";", 1)[0];
  const restricted = await app.inject({ method: "GET", url: "/api/users", headers: { cookie } });
  assert.equal(restricted.statusCode, 403);

  await db.membership.update({ where: { chatId_actorId: { chatId: chat.id, actorId: actor.id } }, data: { revokedAt: new Date(start) } });
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).json(), { actor: null });
});

test("guest-link and guest-session clocks expire independently", async (t) => {
  const { app, db, admin, advance } = await fixture(t);
  const cookie = (await login(app)).split(";", 1)[0];
  const chat = await db.chat.create({ data: { kind: "group", ownerId: admin.id, title: "Встреча" } });
  await db.membership.create({ data: { actorId: admin.id, chatId: chat.id } });
  const url = `/api/chats/${chat.id}/invites`;
  const { token: expiredToken } = await issueInvite(app, url, cookie);
  advance(day);
  const expired = await app.inject({ method: "POST", url: "/api/invites/accept", payload: { kind: "guest", token: expiredToken, displayName: "Гость" } });
  assert.equal(expired.statusCode, 404);
  const { token } = await issueInvite(app, url, cookie);
  const accepted = await app.inject({ method: "POST", url: "/api/invites/accept", payload: { kind: "guest", token, displayName: "Гость" } });
  assert.equal(accepted.statusCode, 200);
  const guestCookie = String(accepted.headers["set-cookie"]).split(";", 1)[0];

  advance(7 * day - 1);
  const before = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: guestCookie } });
  assert.equal(before.json().actor.role, "guest");
  advance(1);
  const expiredSession = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: guestCookie } });
  assert.deepEqual(expiredSession.json(), { actor: null });
});

test("a signed-in nonmember cannot replace their session or consume another group's guest link", async (t) => {
  const { app, db, admin } = await fixture(t);
  const adminCookie = (await login(app)).split(";", 1)[0];
  const account = await issueInvite(app, "/api/invites/account", adminCookie);
  const registration = await app.inject({ method: "POST", url: "/api/invites/accept", payload: {
    kind: "account", token: account.token, ...memberCredentials,
  } });
  assert.equal(registration.statusCode, 200);
  const memberCookie = String(registration.headers["set-cookie"]).split(";", 1)[0];
  const chat = await db.chat.create({ data: { kind: "group", ownerId: admin.id, title: "Встреча" } });
  await db.membership.create({ data: { actorId: admin.id, chatId: chat.id } });
  const url = `/api/chats/${chat.id}/invites`;
  const { token } = await issueInvite(app, url, adminCookie);

  assert.equal((await app.inject({ method: "GET", url, headers: { cookie: memberCookie } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/invites/account", headers: { cookie: memberCookie } })).statusCode, 403);
  const payload = { kind: "guest", token, displayName: "Гость" };
  const refused = await app.inject({ method: "POST", url: "/api/invites/accept", headers: { cookie: memberCookie }, payload });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.headers["set-cookie"], undefined);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: memberCookie } })).json(), registration.json());
  assert.equal((await app.inject({ method: "POST", url: "/api/invites/accept", payload })).statusCode, 200);
});

test("public login rejects repeated failed authentication and recovers after the attempt window", async (t) => {
  const { app, advance } = await fixture(t);
  const attempt = () => app.inject({
    method: "POST", url: "/api/login", payload: { ...adminCredentials, password: "wrong password" },
  });
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await attempt()).statusCode, 401);
  }
  assert.equal((await attempt()).statusCode, 429);
  advance(5 * 60 * 1000);
  await login(app);
});

test("managed accounts prevent invite redemption and allow a provisioned login", async (t) => {
  const { app, db } = await fixture(t);
  const cookie = (await login(app)).split(";", 1)[0];
  const { token } = await issueInvite(app, "/api/invites/account", cookie);
  const previous = process.env.PROVISIONED_ACCOUNTS_ONLY;
  process.env.PROVISIONED_ACCOUNTS_ONLY = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.PROVISIONED_ACCOUNTS_ONLY;
    else process.env.PROVISIONED_ACCOUNTS_ONLY = previous;
  });
  const rejected = await app.inject({ method: "POST", url: "/api/invites/accept", payload: {
    kind: "account", token, ...memberCredentials,
  } });
  assert.equal(rejected.statusCode, 403);
  const shortPassword = "sample";
  await db.actor.create({ data: {
    login: "provisioned", displayName: "Участник", role: "member", passwordHash: await hashPassword(shortPassword),
  } });
  const signedIn = await app.inject({ method: "POST", url: "/api/login", payload: { login: "provisioned", password: shortPassword } });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  assert.equal(signedIn.json().actor.role, "member");
});
