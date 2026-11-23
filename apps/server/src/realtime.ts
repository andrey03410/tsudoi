import type { LiveEvent } from "@tsudoi/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { getActor, requireActor } from "./auth.js";
import type { AppContext } from "./context.js";

interface Connection {
  request: FastifyRequest;
  expires?: ReturnType<typeof setTimeout>;
  alive: boolean;
}

export function registerRealtime(app: FastifyInstance, context: AppContext) {
  const connections = new Map<WebSocket, Connection>();
  let queue: Promise<void> = Promise.resolve();

  const send = (socket: WebSocket, event: LiveEvent) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };

  async function checkedActor(socket: WebSocket, request: FastifyRequest) {
    try {
      const actor = await getActor(request, context);
      if (!actor) socket.close(4001, "Access ended");
      return actor;
    } catch {
      app.log.warn("WebSocket access check failed");
      socket.close(1013, "Access check unavailable");
      return null;
    }
  }

  const enqueue = (action: () => Promise<void>) => {
    queue = queue.then(action).catch((error: unknown) => {
      app.log.error(error, "Realtime notification failed");
    });
  };

  app.get("/ws", {
    websocket: true,
    preValidation: async (request) => {
      await requireActor(request, context);
    },
  }, (socket, request) => {
    const connection: Connection = { request, alive: true };
    connections.set(socket, connection);
    socket.on("close", () => {
      clearTimeout(connection.expires);
      connections.delete(socket);
    });
    socket.on("error", () => socket.terminate());
    socket.on("pong", () => { connection.alive = true; });

    enqueue(async () => {
      const actor = await checkedActor(socket, request);
      if (actor?.expiresAt && socket.readyState === socket.OPEN) {
        const delay = Math.max(0, Date.parse(actor.expiresAt) - context.now().getTime());
        if (delay < 2_147_483_647) {
          connection.expires = setTimeout(() => socket.close(4001, "Access ended"), delay);
          connection.expires.unref();
        }
      }
    });
  });

  const heartbeat = setInterval(() => enqueue(async () => {
    for (const [socket, connection] of connections) {
      if (socket.readyState !== socket.OPEN) continue;
      if (!connection.alive) {
        socket.terminate();
        continue;
      }
      if (!await checkedActor(socket, connection.request)) continue;
      connection.alive = false;
      if (socket.readyState === socket.OPEN) socket.ping();
    }
  }), 15_000);
  heartbeat.unref();

  app.addHook("preClose", async () => {
    clearInterval(heartbeat);
    for (const socket of connections.keys()) socket.terminate();
    await queue;
  });

  context.notify = (chatId, additionalActorIds = []) => enqueue(async () => {
    for (const [socket, connection] of connections) {
      if (socket.readyState !== socket.OPEN) continue;
      const actor = await checkedActor(socket, connection.request);
      if (!actor) continue;
      const membership = chatId ? await context.db.membership.findFirst({
        where: {
          chatId,
          actorId: actor.id,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: context.now() } }],
        },
        select: { chatId: true },
      }) : null;
      if (membership) {
        send(socket, { type: "changed", chatId });
      } else if (additionalActorIds.includes(actor.id)) {
        send(socket, { type: "changed" });
      }
    }
  });
}
