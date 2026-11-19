import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootstrapAdmin } from "./admin.js";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";

test("rejects a cross-origin mutation before routing it", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "tsudoi-app-test-"));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const app = await createApp({ storageDir, origin: "https://tsudoi.example" });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/mutation",
    headers: { origin: "https://other.example" },
    payload: {},
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "ORIGIN_FORBIDDEN");
});

test("requires an active session before accepting a WebSocket", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "tsudoi-ws-test-"));
  const app = await createApp({ storageDir });
  t.after(async () => {
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = get(`${address}/ws`, {
      timeout: 2000,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("timeout", () => request.destroy(new Error("WebSocket handshake timeout")));
    request.on("error", reject);
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
  });
  assert.equal(status, 401);
});

test("always marks session cookies Secure on an HTTPS public origin", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "tsudoi-https-test-"));
  const db = await openDatabase(storageDir);
  const password = "fixture-https-password";
  try {
    await bootstrapAdmin(db, { login: "owner", displayName: "Owner", password });
  } finally {
    await db.$disconnect();
  }
  const app = await createApp({ storageDir, origin: "https://chat.example", secureCookies: false });
  t.after(async () => {
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });
  const response = await app.inject({
    method: "POST", url: "/api/login", payload: { login: "owner", password },
    headers: { origin: "https://chat.example" },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(/; Secure(?:;|$)/.test(String(response.headers["set-cookie"])), "Expected a Secure session cookie");
});

test("keeps login limits separate for forwarded clients of the trusted proxy", async (t) => {
  const storageDir = await mkdtemp(join(tmpdir(), "tsudoi-proxy-test-"));
  const app = await createApp({ storageDir, trustProxy: ["127.0.0.1"] });
  t.after(async () => {
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });
  const invalidLogin = (ip: string) => app.inject({
    method: "POST", url: "/api/login", payload: {},
    remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": ip },
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await invalidLogin("192.0.2.1")).statusCode, 401);
  }
  assert.equal((await invalidLogin("192.0.2.1")).statusCode, 429);
  assert.equal((await invalidLogin("192.0.2.2")).statusCode, 401);
});
