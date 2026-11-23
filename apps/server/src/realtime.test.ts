import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";

test("a failed Kaname check closes only the affected socket and delivers the same chat event to a guest", async (t) => {
  const issuer = "http://localhost";
  const env = {
    KANAME_ENABLED: "1",
    KANAME_GUESTS: "1",
    KANAME_URL: issuer,
    KANAME_SITE_URL: issuer,
    KANAME_OIDC_ISSUER: issuer,
    KANAME_SERVICE_TOKEN: "test",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let unavailable = false;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.pathname, "/internal/v1/access/member");
    if (unavailable) return new Response(null, { status: 503 });
    return Response.json({
      subject: "member",
      login: "member",
      service: "tsudoi",
      role: "user",
      permissions: { heavy: false, html: false },
      limits: {
        storageBytes: null,
        groups: 3,
        configs: null,
        lobbies: null,
        items: null,
        publications: null,
        projects: null,
      },
    });
  });
  const storageDir = await mkdtemp(join(tmpdir(), "tsudoi-realtime-"));
  const db = await openDatabase(storageDir);
  const app = await createApp({ storageDir });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    await db.$disconnect();
    await rm(storageDir, { recursive: true, force: true });
  });
  const member = await db.actor.create({
    data: { role: "member", displayName: "Member", kanameIssuer: issuer, kanameSubject: "member" },
  });
  const guest = await db.actor.create({ data: { role: "guest", displayName: "Guest" } });
  const expiresAt = new Date(Date.now() + 60000);
  const chat = await db.chat.create({
    data: {
      kind: "group",
      title: "Test",
      ownerId: member.id,
      memberships: { create: [{ actorId: member.id }, { actorId: guest.id, expiresAt }] },
    },
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  async function connect(id: string, permanent: boolean) {
    const token = randomBytes(32).toString("base64url");
    await db.session.create({
      data: {
        actorId: id,
        kanameSession: permanent,
        expiresAt,
        tokenHash: createHash("sha256").update(token).digest("hex"),
      },
    });
    const socket = new WebSocket(base.replace("http:", "ws:") + "/ws", {
      headers: { cookie: "tsudoi_session=" + token },
    });
    sockets.push(socket);
    await once(socket, "open", { signal: AbortSignal.timeout(3000) });
    return { socket, token };
  }
  const first = await connect(member.id, true);
  const second = await connect(guest.id, false);
  async function post(clientId: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/chats/" + chat.id + "/messages",
      cookies: { tsudoi_session: second.token },
      payload: { clientId, text: "Hello" },
    });
    assert.equal(res.statusCode, 200, res.body);
  }
  function changed(socket: WebSocket) {
    return once(socket, "message", { signal: AbortSignal.timeout(2500) }).then(([raw]) =>
      assert.deepEqual(JSON.parse(raw.toString()), { type: "changed", chatId: chat.id }),
    );
  }
  await Promise.all([changed(first.socket), changed(second.socket), post("before")]);
  unavailable = true;
  const closed = once(first.socket, "close", { signal: AbortSignal.timeout(2500) });
  const denied: unknown[] = [];
  first.socket.on("message", (data) => denied.push(data));
  const [close] = await Promise.all([closed, changed(second.socket), post("during")]);
  assert.equal(close[0], 1013);
  assert.deepEqual(denied, []);
});
