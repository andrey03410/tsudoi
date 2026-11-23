import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import { registerAuthRoutes } from "./auth.js";
import { registerChatRoutes } from "./chat.js";
import type { AppContext } from "./context.js";
import { openDatabase } from "./db.js";
import { ApiError, fail } from "./errors.js";
import { registerRealtime } from "./realtime.js";

interface AppOptions {
  storageDir: string;
  secureCookies?: boolean;
  origin?: string;
  trustProxy?: string[];
  now?: () => Date;
  webRoot?: string;
  logger?: boolean;
}

export async function createApp(options: AppOptions) {
  const origin = options.origin ? new URL(options.origin).origin : undefined;
  const storageDir = resolve(options.storageDir);
  const db = await openDatabase(storageDir);
  const app = Fastify({ logger: options.logger ? { serializers: { req: request => ({
    method: request.method, url: request.url?.split("?")[0], remoteAddress: request.ip,
  }) } } : false, trustProxy: options.trustProxy ?? false });
  const context: AppContext = {
    db,
    storageDir,
    secureCookies: Boolean(options.secureCookies || origin?.startsWith("https://")),
    now: options.now ?? (() => new Date()),
    notify() {},
  };

  app.addHook("onClose", async () => db.$disconnect());
  app.addHook("onRequest", async (request, reply) => {
    if (isMutationOrUpgrade(request) && !sameOrigin(request, origin)) {
      fail(403, "ORIGIN_FORBIDDEN", "Этот запрос должен быть отправлен из Tsudoi.");
    }

    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    if (request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    }

    if ((error as {statusCode?:number}).statusCode === 503) return reply.code(503).send({error:{code:"ACCESS_UNAVAILABLE",message:"Проверка доступа временно недоступна."}});
    const info = error as { statusCode?: number; code?: string };
    if (info.statusCode && info.statusCode >= 400 && info.statusCode < 500) {
      const message = info.statusCode === 413 ? "Слишком большой запрос." : "Проверь данные запроса.";
      return reply.code(info.statusCode).send({ error: { code: info.code ?? "BAD_REQUEST", message } });
    }

    request.log.error(error, "Request failed");
    return reply.code(500).send({ error: { code: "SERVER_ERROR", message: "Не удалось выполнить запрос. Попробуй ещё раз." } });
  });

  try {
    await app.register(cookie);
    await app.register(websocket, { options: { maxPayload: 1024 } });
    await app.register(multipart, { limits: { files: 1, fields: 0, parts: 2, fileSize: 25 * 1024 * 1024 + 1 } });
    app.get("/health", async () => ({ status: "ok" }));
    registerRealtime(app, context);
    registerAuthRoutes(app, context);
    registerChatRoutes(app, context);

    if (options.webRoot) {
      app.addHook("onSend", async (request, reply) => {
        const contentType = reply.getHeader("content-type");
        if (typeof contentType === "string" && contentType.startsWith("text/html")) {
          reply.header("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        }
      });
      await app.register(fastifyStatic, { root: options.webRoot });
      app.get("/chat/:id", (request, reply) => reply.sendFile("index.html"));
      app.get("/invite/:kind", (request, reply) => reply.sendFile("index.html"));
    }

    app.setNotFoundHandler((request, reply) => {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Страница не найдена." } });
    });
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

function isMutationOrUpgrade(request: FastifyRequest): boolean {
  return request.headers.upgrade?.toLowerCase() === "websocket"
    || !["GET", "HEAD", "OPTIONS"].includes(request.method);
}

function sameOrigin(request: FastifyRequest, origin?: string): boolean {
  const source = request.headers.origin;
  if (typeof source === "string") {
    return source === (origin ?? `${request.protocol}://${request.headers.host}`);
  }
  return request.headers["sec-fetch-site"] !== "cross-site";
}
