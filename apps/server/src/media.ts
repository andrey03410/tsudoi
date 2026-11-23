import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Attachment } from "@tsudoi/contracts";
import type { FastifyInstance } from "fastify";
import { withOwnerPool } from "./pool-lock.js";
import { kanameEnabled } from "@kaname/service-client";
import type { SiteActor } from "./kaname.js";
import { requireActor } from "./auth.js";
import { membership } from "./chat-access.js";
import type { AppContext } from "./context.js";
import { fail } from "./errors.js";

const FILE_LIMIT = 25 * 1024 * 1024;
const publicFields = { id: true, name: true, mime: true, size: true } as const;

function rasterMime(head: Buffer) {
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return "image/jpeg";
  const signature = head.toString("latin1");
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) return "image/gif";
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

function filename(source: string) {
  const base = source.split(/[\\/]/).at(-1) ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return Array.from(cleaned).slice(0, 240).join("") || "file";
}

function disposition(name: string, inline: boolean) {
  const ascii = name.replace(/[^a-zA-Z0-9 ._-]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => "%" + char.charCodeAt(0).toString(16));
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const HOUR = 60 * 60 * 1000;
const UPLOAD_LIFETIME = 24 * HOUR;
const BATCH_SIZE = 128;
const blobName = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

async function cleanUploads(context: AppContext, directory: string, writing: Set<string>) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cutoff = new Date(context.now().getTime() - UPLOAD_LIFETIME);
  const expired = { createdAt: { lte: cutoff }, messageId: null };
  // Claim abandoned records in the same transaction used to check that no message owns them.
  for (;;) {
    const rows = await context.db.$transaction(async tx => {
      const rows = await tx.attachment.findMany({ where: expired, select: { id: true }, take: BATCH_SIZE });
      if (rows.length) await tx.attachment.deleteMany({ where: { ...expired, id: { in: rows.map(row => row.id) } } });
      return rows;
    });
    for (const { id } of rows) await rm(join(directory, id), { force: true });
    if (rows.length < BATCH_SIZE) break;
  }

  // A crash can leave a blob before its database insert, or after a pending record's deletion.
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries.filter(file => file.isFile() && blobName.test(file.name) && !writing.has(file.name));
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const names = candidates.slice(i, i + BATCH_SIZE).map(file => file.name);
    const rows = await context.db.attachment.findMany({ where: { id: { in: names } }, select: { id: true } });
    const tracked = new Set(rows.map(row => row.id));
    for (const name of names) {
      if (tracked.has(name)) continue;
      const path = join(directory, name);
      const file = await stat(path, { throwIfNoEntry: false });
      if (file && file.mtime <= cutoff) await rm(path, { force: true });
    }
  }
}

export function registerMediaRoutes(app: FastifyInstance, context: AppContext) {
  const directory = join(context.storageDir, "files");
  const writing = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let cleanup: Promise<void> | undefined;
  function sweep() {
    cleanup ??= cleanUploads(context, directory, writing)
      .catch(err => { app.log.warn({ err }, "Could not clean up expired uploads"); })
      .finally(() => { cleanup = undefined; });
    return cleanup;
  }
  app.addHook("onReady", async () => {
    await sweep();
    timer = setInterval(sweep, HOUR).unref();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await cleanup;
  });
  app.post<{ Params: { id: string } }>("/api/chats/:id/uploads", async (request, reply) => {
    const actor = await requireActor(request, context);
    if (kanameEnabled() && actor.role === "guest") fail(403, "guest_text", "Гостям доступна текстовая переписка.");
    return withOwnerPool(actor.id, async () => {
    const quota = (actor as SiteActor).grant?.limits.storageBytes;
    const existing = quota == null ? 0 : (await context.db.attachment.aggregate({where:{uploadedById:actor.id},_sum:{size:true}}))._sum.size ?? 0;
    const fileLimit = kanameEnabled() ? 25_000_000 : FILE_LIMIT;
    const chatId = request.params.id;
    await context.db.$transaction(tx => membership(tx, chatId, actor.id, context.now()));
    if (!request.isMultipart()) fail(400, "missing_file", "Выберите файл.");
    const id = randomUUID();
    const path = join(directory, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    writing.add(id);
    try {
      let metadata: Attachment | undefined;
      const parts = request.parts({ limits: { files: 1, parts: 2, fields: 0, fileSize: FILE_LIMIT + 1 } });
      for await (const part of parts) {
        if (part.type !== "file" || !part.filename) fail(400, "missing_file", "Выберите файл.");
        let size = 0;
        let head: Buffer = Buffer.alloc(0);
        await pipeline(part.file, async function* (source) {
          for await (const chunk of source) {
            const bytes = Buffer.from(chunk);
            if (head.length < 12) head = Buffer.concat([head, bytes.subarray(0, 12 - head.length)]);
            size += bytes.length;
            if (size > fileLimit || quota != null && existing + size > quota) fail(413, "file_too_large", "Превышен лимит размера загрузки.");
            yield bytes;
          }
        }, createWriteStream(path, { flags: "wx", mode: 0o600 }));
        if (part.file.truncated || size > FILE_LIMIT) fail(413, "file_too_large", "Файл должен быть не больше 25 МиБ.");
        metadata = { id, name: filename(part.filename), mime: rasterMime(head), size };
      }
      if (!metadata) fail(400, "missing_file", "Выберите файл.");
      const data = metadata;
      const freshActor = kanameEnabled() ? await requireActor(request, context) as SiteActor : null;
      const currentLimit = freshActor?.grant?.limits.storageBytes;
      const result = await context.db.$transaction(async tx => {
        const now = context.now();
        await membership(tx, chatId, actor.id, now);
        if (currentLimit != null) {
          const used = await tx.attachment.aggregate({where:{uploadedById:actor.id},_sum:{size:true}});
          if ((used._sum.size ?? 0) + data.size > currentLimit) fail(409, "storage_quota", "Недостаточно свободного места в Tsudoi.");
        }
        return tx.attachment.create({ data: { ...data, chatId, uploadedById: actor.id, createdAt: now }, select: publicFields });
      });
      return reply.code(201).send(result);
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    } finally {
      writing.delete(id);
    }
    });
  });

  app.delete<{ Params: { uploadId: string } }>("/api/uploads/:uploadId", async request => {
    const actor = await requireActor(request, context);
    const file = await context.db.$transaction(async tx => {
      const row = await tx.attachment.findFirst({
        where: { id: request.params.uploadId, uploadedById: actor.id, messageId: null },
      });
      if (!row) fail(404, "file_unavailable", "Файл недоступен.");
      await membership(tx, row.chatId, actor.id, context.now());
      return tx.attachment.delete({ where: { id: row.id }, select: { id: true } });
    });
    await rm(join(directory, file.id), { force: true });
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/files/:id", async (request, reply) => {
    const actor = await requireActor(request, context);
    const file = await context.db.$transaction(async tx => {
      const row = await tx.attachment.findUnique({ where: { id: request.params.id } });
      if (!row || row.messageId === null) fail(404, "file_unavailable", "Файл недоступен.");
      const member = await membership(tx, row.chatId, actor.id, context.now());
      if (row.messageId < member.firstVisibleId) fail(404, "file_unavailable", "Файл недоступен.");
      return row;
    });
    const handle = await open(join(directory, file.id), "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") fail(404, "file_unavailable", "Файл недоступен.");
      throw error;
    });
    const inline = file.mime.startsWith("image/") && request.query.download !== "1";
    return reply.header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", disposition(file.name, inline))
      .header("Content-Length", file.size)
      .type(inline ? file.mime : "application/octet-stream")
      .send(handle.createReadStream());
  });
}
