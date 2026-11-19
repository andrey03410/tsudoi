import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Actor, Attachment, ChatDetail, ChatSummary, InviteAccepted, IssuedInvite, Message, MessagePage } from "@tsudoi/contracts";
import type { FastifyInstance, HTTPMethods } from "fastify";
import { bootstrapAdmin } from "./admin.js";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";

function request(app: FastifyInstance, method: HTTPMethods, url: string, cookie: string, payload?: object) {
  return app.inject({ method, url, headers: { cookie }, payload });
}

async function json<T>(app: FastifyInstance, method: HTTPMethods, url: string, cookie: string, payload?: object) {
  const response = await request(app, method, url, cookie, payload);
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
  return response.json<T>();
}

async function fixture(t: TestContext) {
  const storageDir = await mkdtemp(join(tmpdir(), "tsudoi-chats-"));
  const db = await openDatabase(storageDir);
  const credentials = { login: "owner", password: "test chat password", displayName: "Owner" };
  let owner: Actor;
  try {
    owner = await bootstrapAdmin(db, credentials);
  } finally {
    await db.$disconnect();
  }
  let time = Date.parse("2026-11-19T08:00:00Z");
  const app = await createApp({ storageDir, now: () => new Date(time), secureCookies: false });
  t.after(async () => { await app.close(); await rm(storageDir, { recursive: true, force: true }); });
  const login = await request(app, "POST", "/api/login", "", credentials);
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  const invite = await json<IssuedInvite>(app, "POST", "/api/invites/account", cookie);
  const accepted = await request(app, "POST", "/api/invites/accept", "", {
    kind: "account", token: invite.token, login: "friend", displayName: "Friend", password: credentials.password,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const member = accepted.json<InviteAccepted>().actor;
  const memberCookie = String(accepted.headers["set-cookie"]).split(";", 1)[0];
  const group = async (memberIds: string[] = []) =>
    (await json<{ id: string }>(app, "POST", "/api/chats/group", cookie, { title: "Group", memberIds })).id;
  return { app, owner, member, cookie, memberCookie, group, storageDir, now: () => new Date(time), advance: (ms: number) => { time += ms; } };
}

test("direct chat is unique for a pair and named for the peer", async (t) => {
  const { app, owner, member, cookie, memberCookie } = await fixture(t);
  assert.equal((await request(app, "GET", "/api/chats", "")).statusCode, 401);
  const [first, second] = await Promise.all([
    json<{ id: string }>(app, "POST", "/api/chats/direct", cookie, { userId: member.id }),
    json<{ id: string }>(app, "POST", "/api/chats/direct", memberCookie, { userId: owner.id }),
  ]);
  assert.equal(first.id, second.id);
  const direct = await json<ChatDetail>(app, "GET", `/api/chats/${first.id}`, memberCookie);
  assert.equal(direct.title, "Owner");
  assert.equal(direct.members.length, 2);
  assert.equal(direct.isOwner, false);
  assert.ok((await request(app, "POST", "/api/chats/direct", cookie, { userId: owner.id })).statusCode >= 400);
});

test("older history, read position and reaction updates use independent durable cursors", async (t) => {
  const { app, member, cookie, memberCookie, group } = await fixture(t);
  const chat = `/api/chats/${await group([member.id])}`;
  const ids: number[] = [];
  for (let i = 0; i < 42; i++) {
    ids.push((await json<Message>(app, "POST", chat + "/messages", cookie, { clientId: String(i), text: String(i) })).id);
  }
  const recent = await json<MessagePage>(app, "GET", chat + "/messages", memberCookie);
  assert.deepEqual(recent.messages.map(m => m.id), ids.slice(2));
  assert.equal(recent.hasMore, true);
  const old = await json<MessagePage>(app, "GET", chat + "/messages?before=" + ids[2], memberCookie);
  assert.deepEqual(old.messages.map(m => m.id), ids.slice(0, 2));
  assert.equal(old.hasMore, false);
  for (const messageId of [ids[39], ids[0]]) {
    await json(app, "POST", chat + "/read", memberCookie, { messageId });
  }
  const [summary] = await json<ChatSummary[]>(app, "GET", "/api/chats", memberCookie);
  assert.equal(summary.unreadCount, 2);
  assert.equal(summary.preview, "41");
  const target = chat + "/messages/" + ids[0] + "/reactions";
  for (const user of [cookie, memberCookie, memberCookie]) {
    await json(app, "PUT", target, user, { emoji: "👍", active: true });
  }
  const changes = await json<MessagePage>(app, "GET", chat + "/changes?after=" + recent.cursor, memberCookie);
  assert.equal(changes.hasMore, false);
  assert.deepEqual(changes.messages.map(m => m.id), [ids[0]]);
  assert.deepEqual(changes.messages[0].reactions, [{ emoji: "👍", count: 2, mine: true, guestCount: 0 }]);
  const next = await json<MessagePage>(app, "GET", chat + "/changes?after=" + changes.cursor, cookie);
  assert.deepEqual(next.messages, []);
  const removed = await json<Message>(app, "PUT", target, cookie, { emoji: "👍", active: false });
  assert.deepEqual(removed.reactions, [{ emoji: "👍", count: 1, mine: false, guestCount: 0 }]);
});

function upload(app: FastifyInstance, chat: string, cookie: string, name: string, bytes: Buffer) {
  const boundary = "tsudoi-integration-test";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: "POST", url: chat + "/uploads", headers: {
    cookie, "content-type": "multipart/form-data; boundary=" + boundary,
  }, payload: body });
}

async function staged(app: FastifyInstance, chat: string, cookie: string, name: string, bytes: Buffer) {
  const response = await upload(app, chat, cookie, name, bytes);
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
  return response.json<Attachment>();
}

test("only a sender can attach their staged file once in its original chat", async (t) => {
  const { app, member, cookie, memberCookie, group } = await fixture(t);
  const chat = "/api/chats/" + await group([member.id]);
  const other = "/api/chats/" + await group();
  const attachment = await staged(app, chat, cookie, "board.svg", Buffer.from("<svg/>"));
  assert.equal(attachment.mime, "application/octet-stream");
  const file = "/api/files/" + attachment.id;
  assert.equal((await request(app, "GET", file, cookie)).statusCode, 404);
  const send = { clientId: "repeatable", attachmentIds: [attachment.id], text: "Board" };
  for (const [url, user] of [[chat, memberCookie], [other, cookie]]) {
    assert.ok((await request(app, "POST", url + "/messages", user, send)).statusCode >= 400);
  }
  const copies = await Promise.all([1, 2].map(() => json<Message>(app, "POST", chat + "/messages", cookie, send)));
  assert.equal(copies[0].id, copies[1].id);
  assert.deepEqual(copies[1].attachments, [attachment]);
  assert.deepEqual((await json<MessagePage>(app, "GET", chat + "/messages", cookie)).messages, [copies[0]]);
  const download = await request(app, "GET", file, memberCookie);
  assert.equal(download.body, "<svg/>");
  assert.match(String(download.headers["content-disposition"]), /^attachment;/);
  assert.match(String(download.headers["cache-control"]), /no-store/);
  assert.ok((await request(app, "POST", chat + "/messages", cookie, { ...send, clientId: "new" })).statusCode >= 400);
  const spare = await staged(app, chat, cookie, "spare.txt", Buffer.from("draft"));
  await json(app, "DELETE", "/api/uploads/" + spare.id, cookie);
  assert.ok((await request(app, "POST", chat + "/messages", cookie, { ...send, clientId: "draft", attachmentIds: [spare.id] })).statusCode >= 400);
  assert.equal((await upload(app, chat, cookie, "big.bin", Buffer.alloc(25 * 1024 * 1024 + 1))).statusCode, 413);
});

test("guest history begins on entry and membership removal revokes file and message access", async (t) => {
  const { app, owner, member, cookie, memberCookie, group } = await fixture(t);
  const chat = "/api/chats/" + await group();
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const oldFile = await staged(app, chat, cookie, "before.gif", gif);
  const old = await json<Message>(app, "POST", chat + "/messages", cookie, { clientId: "before", attachmentIds: [oldFile.id] });
  const invite = await json<IssuedInvite>(app, "POST", chat + "/invites", cookie);
  const entered = await request(app, "POST", "/api/invites/accept", "", { kind: "guest", token: invite.token, displayName: "Guest" });
  assert.equal(entered.statusCode, 200, entered.body);
  const guest = String(entered.headers["set-cookie"]).split(";", 1)[0];
  const guestActor = entered.json<InviteAccepted>().actor;
  const summary = await json<ChatDetail>(app, "GET", chat, guest);
  assert.equal(summary.preview, null);
  assert.equal(summary.unreadCount, 0);
  assert.equal(summary.members.find(m => m.id === guestActor.id)?.expiresAt, guestActor.expiresAt);
  assert.equal((await request(app, "GET", "/api/files/" + oldFile.id, guest)).statusCode, 404);
  assert.equal((await request(app, "PUT", chat + "/messages/" + old.id + "/reactions", guest, { active: true, emoji: "👍" })).statusCode, 404);
  await json(app, "PUT", chat + "/messages/" + old.id + "/reactions", cookie, { active: true, emoji: "👍" });
  const recent = await staged(app, chat, guest, "recent.gif", gif);
  assert.equal(recent.mime, "image/gif");
  const visible = await json<Message>(app, "POST", chat + "/messages", guest, { clientId: "after", attachmentIds: [recent.id] });
  assert.deepEqual((await json<MessagePage>(app, "GET", chat + "/changes?after=0", guest)).messages.map(m => m.id), [visible.id]);
  assert.deepEqual((await json<MessagePage>(app, "GET", chat + "/messages", guest)).messages.map(m => m.id), [visible.id]);
  await json(app, "PUT", chat + "/messages/" + visible.id + "/reactions", guest, { active: true, emoji: "👍" });
  const url = "/api/files/" + recent.id;
  assert.match(String((await request(app, "GET", url, guest)).headers["content-disposition"]), /^inline;/);
  assert.match(String((await request(app, "GET", url + "?download=1", guest)).headers["content-disposition"]), /^attachment;/);
  await json(app, "POST", chat + "/members", cookie, { actorId: member.id });
  assert.equal((await json<MessagePage>(app, "GET", chat + "/messages", memberCookie)).messages.length, 2);
  assert.ok((await request(app, "DELETE", chat + "/members/" + guestActor.id, memberCookie)).statusCode >= 400);
  assert.ok((await request(app, "DELETE", chat + "/members/" + owner.id, cookie)).statusCode >= 400);
  await json(app, "DELETE", chat + "/members/" + guestActor.id, cookie);
  for (const path of [chat, chat + "/messages", chat + "/changes?after=0", url]) {
    assert.ok((await request(app, "GET", path, guest)).statusCode >= 400);
  }
  const afterRevocation = (await json<MessagePage>(app, "GET", chat + "/messages", cookie)).messages[1];
  assert.equal(afterRevocation.author.role, "guest");
  assert.deepEqual(afterRevocation.reactions, [{ emoji: "👍", count: 1, mine: false, guestCount: 1 }]);
});

test("message formats reject empty sends, unknown stickers and six attachments", async t => {
  const { app, cookie, group } = await fixture(t);
  const chat = "/api/chats/" + await group();
  const files = [];
  for (let i = 0; i < 6; i++) {
    files.push(await staged(app, chat, cookie, "файл" + i + ".txt", Buffer.from("file " + i)));
  }
  for (const payload of [
    { text: " " }, { stickerId: "missing" }, { stickerId: "wave", text: "more" },
    { attachmentIds: files.map(f => f.id) }, { attachmentIds: [files[0].id, files[0].id] },
  ]) {
    const result = await request(app, "POST", chat + "/messages", cookie, { clientId: "invalid", ...payload });
    assert.equal(result.statusCode, 400, result.body);
  }
  const sticker = await json<Message>(app, "POST", chat + "/messages", cookie, { clientId: "sticker", stickerId: "wave" });
  assert.equal(sticker.stickerId, "wave");
  const send = await json<Message>(app, "POST", chat + "/messages", cookie, { clientId: "files", attachmentIds: files.slice(0, 5).map(f => f.id) });
  assert.equal(send.attachments.length, 5);
  assert.equal(files[0].name, "файл0.txt");
  const file = await request(app, "GET", "/api/files/" + files[0].id, cookie);
  assert.match(String(file.headers["content-disposition"]), /filename\*=UTF-8''%D1%84/);
});

test("an expired guest loses reads, reactions, file access and sends", async t => {
  const { app, cookie, group, advance } = await fixture(t);
  const chat = "/api/chats/" + await group();
  const invite = await json<IssuedInvite>(app, "POST", chat + "/invites", cookie);
  const entry = await request(app, "POST", "/api/invites/accept", "", { kind: "guest", token: invite.token, displayName: "Guest" });
  assert.equal(entry.statusCode, 200, entry.body);
  const guest = String(entry.headers["set-cookie"]).split(";", 1)[0];
  const file = await staged(app, chat, guest, "guest.txt", Buffer.from("hello"));
  const message = await json<Message>(app, "POST", chat + "/messages", guest, { clientId: "valid", attachmentIds: [file.id] });
  advance(7 * 24 * 60 * 60 * 1000);
  const probes = [
    request(app, "GET", chat + "/messages", guest),
    request(app, "GET", chat + "/changes?after=0", guest),
    request(app, "GET", "/api/files/" + file.id, guest),
    request(app, "PUT", chat + "/messages/" + message.id + "/reactions", guest, { emoji: "👍", active: true }),
    request(app, "POST", chat + "/messages", guest, { clientId: "expired", text: "late" }),
  ];
  for (const result of await Promise.all(probes)) assert.ok([401, 404].includes(result.statusCode), result.body);
});

test("history, files, sessions and event cursors survive restarting the app", async t => {
  const { app, cookie, group, storageDir, now } = await fixture(t);
  const chat = "/api/chats/" + await group();
  const file = await staged(app, chat, cookie, "notes.txt", Buffer.from("stored bytes"));
  const first = await json<Message>(app, "POST", chat + "/messages", cookie, { clientId: "store", attachmentIds: [file.id] });
  const { cursor } = await json<MessagePage>(app, "GET", chat + "/messages", cookie);
  await json(app, "PUT", chat + "/messages/" + first.id + "/reactions", cookie, { emoji: "🔥", active: true });
  await app.close();
  const restarted = await createApp({ storageDir, now });
  try {
    const changes = await json<MessagePage>(restarted, "GET", chat + "/changes?after=" + cursor, cookie);
    assert.deepEqual(changes.messages.map(m => [m.id, m.reactions]), [[first.id, [{ emoji: "🔥", count: 1, mine: true, guestCount: 0 }]]]);
    assert.equal((await request(restarted, "GET", "/api/files/" + file.id, cookie)).body, "stored bytes");
    const history = await json<MessagePage>(restarted, "GET", chat + "/messages", cookie);
    assert.deepEqual(history.messages, changes.messages);
  } finally { await restarted.close(); }
});

test("chats with simultaneous timestamps follow their latest message order", async t => {
  const { app, cookie, group } = await fixture(t);
  const ids = [await group(), await group()].sort();
  for (const id of ids) await json(app, "POST", "/api/chats/" + id + "/messages", cookie, { clientId: "latest", text: id });
  const list = await json<ChatSummary[]>(app, "GET", "/api/chats", cookie);
  assert.deepEqual(list.map(chat => chat.id), [ids[1], ids[0]]);
});

test("restart reclaims stale pending uploads and interrupted writes while preserving messages and fresh drafts", async t => {
  const { app, cookie, group, storageDir, now, advance } = await fixture(t);
  const chat = "/api/chats/" + await group();
  const dir = join(storageDir, "files");
  const claimed = await staged(app, chat, cookie, "keep.txt", Buffer.from("message"));
  const abandoned = await staged(app, chat, cookie, "stale.txt", Buffer.from("draft"));
  await json(app, "POST", chat + "/messages", cookie, { clientId: "claim", attachmentIds: [claimed.id] });
  const oldOrphan = randomUUID();
  await writeFile(join(dir, oldOrphan), "partial");
  await utimes(join(dir, oldOrphan), now(), now());
  await utimes(join(dir, claimed.id), now(), now());
  advance(25 * 60 * 60 * 1000);
  const fresh = await staged(app, chat, cookie, "fresh.txt", Buffer.from("fresh draft"));
  const newOrphan = randomUUID();
  await writeFile(join(dir, newOrphan), "recent partial");
  await utimes(join(dir, newOrphan), now(), now());
  await app.close();

  const restarted = await createApp({ storageDir, now });
  try {
    await restarted.ready();
    assert.deepEqual((await readdir(dir)).sort(), [claimed.id, fresh.id, newOrphan].sort());
    assert.equal((await request(restarted, "GET", "/api/files/" + claimed.id, cookie)).body, "message");
    const oldAttempt = await request(restarted, "POST", chat + "/messages", cookie, { clientId: "old", attachmentIds: [abandoned.id] });
    assert.equal(oldAttempt.statusCode, 400);
    const freshSend = await json<Message>(restarted, "POST", chat + "/messages", cookie, { clientId: "fresh", attachmentIds: [fresh.id] });
    assert.deepEqual(freshSend.attachments, [fresh]);
  } finally { await restarted.close(); }
});
