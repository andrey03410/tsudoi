import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";

test("Tsudoi applies the Kaname role, group quota and revocation to a live session", async (t) => {
  let revoked = false;
  const server = createServer((_req, res) => {
    if (revoked) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        subject: "sample",
        login: "sample",
        service: "tsudoi",
        role: "user",
        limits: {
          storageBytes: 100,
          items: null,
          configs: null,
          lobbies: null,
          projects: null,
          publications: null,
          groups: 1,
        },
        permissions: { heavy: false, html: true },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const before = { ...process.env };
  const vars = {
    GUESTS: "0",
    ENABLED: "1",
    URL: "http://127.0.0.1:" + addr.port,
    SITE_URL: "http://localhost",
    PUBLIC_URL: "http://localhost",
    OIDC_ISSUER: "http://localhost",
    REPORT_TOKEN: "report",
    SERVICE_TOKEN: "svc",
  };
  for (const [key, value] of Object.entries(vars)) process.env["KANAME_" + key] = value;
  const storageDir = await mkdtemp(join(tmpdir(), "tsudoi-kaname-"));
  const app = await createApp({ storageDir });
  const db = await openDatabase(storageDir);
  t.after(async () => {
    await app.close();
    await db.$disconnect();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    for (const key of Object.keys(vars)) {
      const k = "KANAME_" + key;
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
    await rm(storageDir, { recursive: true, force: true });
  });
  const actor = await db.actor.create({
    data: { displayName: "Sample", role: "admin", kanameSubject: "sample", kanameIssuer: "http://localhost" },
  });
  const token = randomBytes(32).toString("base64url");
  await db.session.create({
    data: {
      actorId: actor.id,
      kanameSession: true,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const cookies = { tsudoi_session: token };
  assert.equal((await app.inject({ url: "/api/me", cookies })).json().actor.role, "member");
  assert.equal((await app.inject({ url: "/admin", cookies })).statusCode, 403);
  const groups = await Promise.all(
    [1, 2].map((index) =>
      app.inject({
        method: "POST",
        url: "/api/chats/group",
        cookies,
        payload: { title: "Test " + index, memberIds: [] },
      }),
    ),
  );
  assert.deepEqual(groups.map((r) => r.statusCode).sort(), [200, 409]);
  const reportUrl = "/internal/kaname/v1/usage/sample";
  assert.equal((await app.inject({ url: reportUrl, headers: { authorization: "Bearer svc" } })).statusCode, 403);
  assert.equal(
    (await app.inject({ url: reportUrl, headers: { authorization: "Bearer report" } })).json().counts.groups,
    1,
  );
  const groupId = groups.find((r) => r.statusCode === 200)!.json().id;
  const invited = "/api/chats/" + groupId + "/invites";
  assert.equal((await app.inject({ method: "POST", url: invited, cookies })).statusCode, 403);
  process.env.KANAME_GUESTS = "1";
  const issue = await app.inject({ method: "POST", url: invited, cookies });
  assert.equal(issue.statusCode, 201);
  const invite = issue.json();
  const guestToken = invite.token;
  const guest = await app.inject({
    method: "POST",
    url: "/api/invites/accept",
    payload: { kind: "guest", token: guestToken, displayName: "Гость" },
  });
  assert.equal(guest.statusCode, 200);
  const guestHeaders = { cookie: String(guest.headers["set-cookie"]).split(";")[0] };
  const messages = "/api/chats/" + groupId + "/messages";
  const msg = await app.inject({
    method: "POST",
    url: messages,
    headers: guestHeaders,
    payload: { clientId: "text", text: "Привет" },
  });
  assert.equal(msg.statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: messages + "/" + msg.json().id + "/reactions",
        headers: guestHeaders,
        payload: { emoji: "👍", active: true },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: messages,
        headers: guestHeaders,
        payload: { clientId: "sticker", stickerId: "wave" },
      })
    ).statusCode,
    403,
  );
  const other = await db.actor.create({
    data: { kanameIssuer: "http://other.example", kanameSubject: "sample", displayName: "Other", role: "admin" },
  });
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/chats/direct", cookies, payload: { userId: other.id } }))
      .statusCode,
    400,
  );
  process.env.KANAME_OIDC_ISSUER = "http://other.example";
  assert.equal((await app.inject({ url: "/api/me", cookies })).json().actor, null);
  assert.equal(
    (await app.inject({ url: reportUrl, headers: { authorization: "Bearer report" } })).json().counts.groups,
    0,
  );
  process.env.KANAME_OIDC_ISSUER = "http://localhost";
  revoked = true;
  assert.equal((await app.inject({ url: "/api/chats", cookies })).statusCode, 401);
});
