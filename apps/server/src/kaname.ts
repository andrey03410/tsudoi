import { access, kanameEnabled, problem, reportAuthorized, type Grant } from "@kaname/service-client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireActor } from "./auth.js";
import type { AppContext } from "./context.js";
import type { Actor } from "@tsudoi/contracts";
export type SiteActor = Actor & { grant?: Grant };

export function siteIdentity(subject: string) {
  const kanameIssuer = process.env.KANAME_OIDC_ISSUER;
  if (!kanameIssuer) throw problem(503, "Служба входа не настроена.");
  return { kanameIssuer, kanameSubject: subject };
}
export async function usage(context: AppContext, subject: string) {
  const row = await context.db.actor.findUnique({
    where: { kanameIssuer_kanameSubject: siteIdentity(subject) },
    select: { id: true },
  });
  if (!row) return { storageBytes: 0, counts: { groups: 0, attachments: 0 }, lastActiveAt: null, activeDays30: 0 };
  const since = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const days = await context.db.kanameActivity.findMany({
    where: { issuer: process.env.KANAME_OIDC_ISSUER!, subject, day: { gte: since } },
    orderBy: { day: "desc" },
  });
  const last = await context.db.kanameActivity.findFirst({
    where: { issuer: process.env.KANAME_OIDC_ISSUER!, subject },
    orderBy: { day: "desc" },
    select: { lastActiveAt: true },
  });
  const [files, groups] = await Promise.all([
    context.db.attachment.aggregate({ where: { uploadedById: row.id }, _sum: { size: true }, _count: true }),
    context.db.chat.count({ where: { ownerId: row.id, kind: "group" } }),
  ]);
  const storageBytes = files._sum.size ?? 0,
    counts = { groups, attachments: files._count };
  return {
    storageBytes,
    counts,
    lastActiveAt: last?.lastActiveAt.toISOString() ?? null,
    activeDays30: days.length,
  };
}

function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function registerKanamePanel(app: FastifyInstance, context: AppContext) {
  if (!kanameEnabled()) return;
  async function principal(request: FastifyRequest) {
    return ((await requireActor(request, context)) as SiteActor).grant;
  }
  async function admin(request: FastifyRequest) {
    const grant = await principal(request);
    if (!grant || grant.role === "user") throw problem(403, "Требуются права администратора площадки.");
    return grant;
  }
  app.get<{ Params: { subject: string } }>("/internal/kaname/v1/usage/:subject", async (request, reply) => {
    if (!reportAuthorized(request.headers.authorization)) throw problem(403, "Нет доступа.");
    return reply.header("cache-control", "no-store").send(await usage(context, request.params.subject));
  });
  app.get("/api/kaname/account", async (request) => {
    const grant = await principal(request);
    if (!grant) throw problem(403, "Нет доступа.");
    return { limits: grant.limits, role: grant.role, usage: await usage(context, grant.subject) };
  });
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 2048 },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  app.post<{ Body: { subject?: string; suspended?: string } }>("/admin/access", async (request, reply) => {
    const operator = await admin(request);
    if (request.headers.origin !== new URL(process.env.KANAME_SITE_URL!).origin)
      throw problem(403, "Запрос должен быть отправлен со страницы управления.");
    const { subject, suspended } = request.body;
    if (!subject || !["1", "0"].includes(suspended ?? "")) throw problem(400, "Проверьте данные запроса.");
    const target = await access("tsudoi", subject);
    if (
      operator.subject === subject ||
      target.role === "overlord" ||
      (operator.role === "admin" && target.role === "admin")
    )
      throw problem(403, "Недостаточно прав.");
    await context.db.actor.update({
      where: { kanameIssuer_kanameSubject: siteIdentity(subject) },
      data: { kanameSuspended: suspended === "1" },
    });
    return reply.redirect("/admin", 303);
  });
  app.post<{ Body: { id: string } }>("/admin/invites/revoke", async (request, reply) => {
    await admin(request);
    if (request.headers.origin !== new URL(process.env.KANAME_SITE_URL!).origin)
      throw problem(403, "Неверный источник.");
    if (typeof request.body?.id !== "string" || !request.body.id || request.body.id.length > 128)
      throw problem(400, "Укажите объект управления.");
    await context.db.invite.updateMany({
      where: {
        id: request.body.id,
        kind: "guest",
        usedAt: null,
        revokedAt: null,
        chat: { owner: { kanameIssuer: process.env.KANAME_OIDC_ISSUER! } },
      },
      data: { revokedAt: new Date() },
    });
    return reply.redirect("/admin", 303);
  });
  app.get("/admin", async (request, reply) => {
    if (!request.cookies.tsudoi_session) return reply.redirect("/api/auth/kaname/login?next=/admin");
    const operator = await admin(request);
    const rows = await context.db.actor.findMany({
      where: { kanameIssuer: process.env.KANAME_OIDC_ISSUER!, kanameSubject: { not: null } },
      orderBy: { displayName: "asc" },
    });
    const list = await Promise.all(
      rows.map(async (row) => {
        const report = await usage(context, row.kanameSubject!);
        const grant = await access("tsudoi", row.kanameSubject!).catch((error) => {
          if (error.statusCode === 403) return null;
          throw error;
        });
        const maySuspend =
          !!grant &&
          operator.subject !== grant.subject &&
          grant.role !== "overlord" &&
          (operator.role === "overlord" || grant.role === "user");
        const action = row.kanameSuspended ? "Восстановить" : "Приостановить";
        const button = maySuspend
          ? `<form method="post" action="/admin/access"><input type="hidden" name="subject"
          value="${escape(row.kanameSubject!)}"><button name="suspended" value="${row.kanameSuspended ? "0" : "1"}">${action}</button></form>`
          : "";
        const status = !grant ? "Нет назначения" : row.kanameSuspended ? "Приостановлен" : "Активен";
        return `<tr><td>${escape(row.displayName ?? "")}</td><td>${new Intl.NumberFormat("ru").format(report.storageBytes)} Б</td>
        <td>${report.activeDays30}</td><td>${status}</td><td>${button}</td></tr>`;
      }),
    );
    const invites = await context.db.invite.findMany({
      where: {
        kind: "guest",
        usedAt: null,
        revokedAt: null,
        chat: { owner: { kanameIssuer: process.env.KANAME_OIDC_ISSUER! } },
        expiresAt: { gt: new Date() },
      },
      select: { id: true, chat: { select: { title: true } } },
    });
    const detail =
      "<h2>Гостевые приглашения</h2>" +
      invites
        .map(
          (i) =>
            '<form method="post" action="/admin/invites/revoke">' +
            escape(i.chat?.title ?? "Группа") +
            ' <button name="id" value="' +
            escape(i.id) +
            '">Отозвать</button></form>',
        )
        .join("");
    return reply
      .header("cache-control", "no-store")
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
      .type("text/html;charset=utf-8").send(`<!doctype html><html lang="ru"><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><title>Tsudoi · Управление</title>
      <style>body{font:16px system-ui;max-width:64rem;margin:3rem auto;padding:0 1rem;color:#242821}section{overflow:auto}
      table{width:100%;border-collapse:collapse}th,td{padding:.7rem;text-align:left;border-bottom:1px solid #ddd}button{padding:.4rem .6rem}a{color:#27503e}</style>
      <nav><a href="/">Tsudoi</a> · <a href="${escape(process.env.KANAME_PUBLIC_URL!)}">Kaname</a></nav>
      <h1>Управление Tsudoi</h1><section><table><thead><tr><th>Участник</th><th>Занято</th><th>Дни за месяц</th>
      <th>Доступ</th><th>Действия</th></tr></thead><tbody>${list.join("")}</tbody></table></section>${detail}</html>`);
  });
  app.addHook("onResponse", async (request, reply) => {
    if (
      reply.statusCode >= 400 ||
      request.method === "OPTIONS" ||
      !/^\/api\/chats\/[^/]+\/(messages|read|uploads)(?:[/?]|$)/.test(request.url)
    )
      return;
    const grant = await principal(request).catch(() => null);
    if (!grant) return;
    await recordActivity(context, grant.subject);
  });
}

export async function recordActivity(context: AppContext, subject: string) {
  const { kanameIssuer: issuer } = siteIdentity(subject);
  const lastActiveAt = new Date();
  const key = { issuer, subject, day: lastActiveAt.toISOString().slice(0, 10) };
  await context.db.kanameActivity.upsert({
    where: { issuer_subject_day: key },
    create: { ...key, lastActiveAt },
    update: { lastActiveAt },
  });
}
