import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { devices, expect, test } from "@playwright/test";
import { bootstrapAdmin } from "../../apps/server/dist/admin.js";
import { createApp } from "../../apps/server/dist/app.js";
import { openDatabase } from "../../apps/server/dist/db.js";

const fixturePassword = "verifiable-fixture-password";
const animatedGif = Buffer.from("47494638396101000100800000ff000000ff0021ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b", "hex");

async function runtime() {
  const storageDir = await mkdtemp(join(tmpdir(), "tsudoi-browser-"));
  let app;
  try {
    const db = await openDatabase(storageDir);
    try {
      await bootstrapAdmin(db, { login: "demo-admin", displayName: "Аки", password: fixturePassword });
    } finally {
      await db.$disconnect();
    }

    const start = async (port = 0) => {
      app = await createApp({ storageDir, webRoot: resolve("apps/web/dist") });
      return app.listen({ host: "127.0.0.1", port });
    };
    const origin = await start();
    return {
      origin,
      async restart() {
        await app.close();
        await start(Number(new URL(origin).port));
      },
      async close() {
        await app.close();
        await rm(storageDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
    throw error;
  }
}

async function login(page, origin, user = "demo-admin") {
  await page.goto(origin);
  await page.getByPlaceholder("Ваш логин").fill(user);
  await page.getByLabel(/^Пароль/).fill(fixturePassword);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Чаты", exact: true })).toBeVisible();
}

async function invite(page) {
  await page.getByRole("button", { name: "Создать приглашение", exact: true }).click();
  const field = page.getByLabel("Ссылка приглашения");
  await expect(field).toHaveValue(/\/invite\/(?:guest|account)#/);
  return field.inputValue();
}

async function send(page, value) {
  await page.getByRole("textbox", { name: "Сообщение" }).fill(value);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(message(page, value)).toBeVisible();
}

function message(page, text) {
  return page.getByRole("article").filter({ hasText: text }).getByText(text, { exact: true });
}

function openNewChat(page) {
  return page.locator(".sidebar-heading").getByRole("button", { name: "Новый чат", exact: true }).click();
}

async function independentContext(browser, isMobile) {
  if (!isMobile) return browser.newContext({ viewport: { width: 1365, height: 900 } });
  const { defaultBrowserType, ...options } = devices["iPhone 13"];
  return browser.newContext(options);
}

test("registration, direct chat, media and sync after disconnect and restart", async ({ page, browser, isMobile }, info) => {
  const service = await runtime();
  const friendContext = await independentContext(browser, isMobile);
  try {
    if (isMobile) await page.addInitScript(() => Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined }));
    await login(page, service.origin);
    await page.getByRole("button", { name: "Приглашения", exact: true }).click();
    const accountLink = await invite(page);
    await page.keyboard.press("Escape");

    const friend = await friendContext.newPage();
    let disconnected = false;
    let connectionCount = 0;
    let socket;
    await friend.routeWebSocket(/\/ws$/, (route) => {
      if (disconnected) {
        route.close();
      } else {
        socket = route;
        route.connectToServer();
        connectionCount++;
      }
    });

    await friend.goto(accountLink);
    await friend.getByLabel("Имя", { exact: true }).fill("Мика");
    await friend.getByLabel("Логин", { exact: true }).fill("mika");
    await friend.getByLabel(/^Пароль/).fill(fixturePassword);
    await friend.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
    await expect(friend.getByRole("heading", { name: "Чаты", exact: true })).toBeVisible();
    await expect.poll(() => connectionCount).toBe(1);

    await openNewChat(page);
    await page.getByRole("button", { name: "Мика", exact: true }).click();
    await send(page, "Привет из Tsudoi");
    await expect(friend.getByLabel("Непрочитанных: 1")).toBeVisible();
    await friend.getByRole("link", { name: /Аки/ }).click();
    await expect(message(friend, "Привет из Tsudoi")).toBeVisible();

    disconnected = true;
    socket.close({ code: 1012 });
    await expect(friend.getByText("Восстанавливаем соединение…")).toBeVisible();

    const first = page.getByRole("article").filter({ hasText: "Привет из Tsudoi" });
    await first.getByRole("button", { name: "Добавить реакцию" }).click();
    await first.getByRole("button", { name: "👍", exact: true }).click();
    await send(page, "Сообщение во время разрыва");
    disconnected = false;
    await expect(message(friend, "Сообщение во время разрыва")).toBeVisible();
    await expect(friend.getByRole("button", { name: "👍 1", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Стикеры", exact: true }).click();
    await page.getByRole("button", { name: "Привет", exact: true }).click();
    const sticker = friend.getByRole("img", { name: "Стикер «Привет»" });
    await expect(sticker).toBeVisible();
    await expect.poll(() => sticker.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);

    await page.getByLabel("Выбрать GIF", { exact: true }).setInputFiles({ name: "circle.gif", mimeType: "image/gif", buffer: animatedGif });
    await page.getByRole("button", { name: "Отправить", exact: true }).click();
    await friend.getByRole("button", { name: "Воспроизвести GIF circle.gif" }).click();
    const gif = friend.getByRole("img", { name: "circle.gif" });
    await expect.poll(() => gif.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    await friend.getByRole("button", { name: "Остановить GIF circle.gif" }).click();
    await expect(gif).toHaveCount(0);

    let attemptId;
    await page.route(/\/api\/chats\/[^/]+\/messages$/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const { clientId } = route.request().postDataJSON();
      if (attemptId) {
        expect(clientId).toBe(attemptId);
        return route.continue();
      }
      attemptId = clientId;
      const saved = await route.fetch();
      expect(saved.ok()).toBe(true);
      await route.abort("failed");
    });
    await page.getByLabel("Выбрать файлы", { exact: true }).setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("file from browser") });
    await page.getByRole("textbox", { name: "Сообщение" }).fill("Файл к сообщению");
    await page.getByRole("button", { name: "Отправить", exact: true }).click();
    const retry = page.getByRole("button", { name: "Повторить отправку", exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(retry).toBeHidden();
    const file = friend.getByRole("link", { name: /note\.txt/ });
    await expect(file).toBeVisible();
    const href = await file.getAttribute("href");
    expect(await (await friend.request.get(new URL(href, service.origin).href)).text()).toBe("file from browser");

    await service.restart();
    await friend.reload();
    await expect(message(friend, "Файл к сообщению")).toBeVisible();
    await expect(message(friend, "Файл к сообщению")).toHaveCount(1);
    expect(await (await friend.request.get(new URL(href, service.origin).href)).text()).toBe("file from browser");
    await friend.screenshot({ path: info.outputPath("conversation.png") });

    if (isMobile) {
      await expect(friend.getByRole("navigation", { name: "Чаты" })).toBeHidden();
      await friend.getByRole("button", { name: "К списку чатов" }).click();
      await expect(friend.getByRole("navigation", { name: "Чаты" })).toBeVisible();
      await friend.getByRole("link", { name: /Аки/ }).tap();
      await expect(friend.getByRole("textbox", { name: "Сообщение" })).toBeInViewport();
    }
  } finally {
    try { await friendContext.close(); } finally { await service.close(); }
  }
});

test("guest sees new messages only and loses access in the open tab on revoke", async ({ page, browser, isMobile }, info) => {
  const service = await runtime();
  const guestContext = await independentContext(browser, isMobile);
  try {
    await login(page, service.origin);
    await openNewChat(page);
    await page.getByRole("button", { name: "Группа", exact: true }).click();
    await page.getByLabel("Название группы").fill("Вечерний чай");
    await page.getByRole("button", { name: "Создать группу" }).click();
    await page.getByLabel("Выбрать файлы", { exact: true }).setInputFiles({ name: "before.txt", mimeType: "text/plain", buffer: Buffer.from("before guest") });
    await send(page, "Внутренняя история");
    const oldHref = await page.getByRole("link", { name: /before\.txt/ }).getAttribute("href");

    await page.getByRole("button", { name: "Участники группы" }).click();
    const guestLink = await invite(page);
    await page.keyboard.press("Escape");

    const guest = await guestContext.newPage();
    await guest.goto(guestLink);
    await guest.getByLabel("Имя", { exact: true }).fill("Юки");
    await guest.getByRole("button", { name: "Войти в группу", exact: true }).click();
    await expect(guest.getByRole("heading", { name: "Вечерний чай", exact: true })).toBeVisible();
    await expect(guest.getByText(/Гостевой доступ до/)).toBeVisible();
    await expect(message(guest, "Внутренняя история")).toHaveCount(0);
    expect((await guest.request.get(new URL(oldHref, service.origin).href)).ok()).toBe(false);

    await page.getByLabel("Выбрать файлы", { exact: true }).setInputFiles({ name: "after.txt", mimeType: "text/plain", buffer: Buffer.from("visible to guest") });
    await send(page, "Привет, гость");
    await expect(message(guest, "Привет, гость")).toBeVisible();
    const currentHref = await guest.getByRole("link", { name: /after\.txt/ }).getAttribute("href");
    expect(await (await guest.request.get(new URL(currentHref, service.origin).href)).text()).toBe("visible to guest");
    await send(guest, "Спасибо за приглашение");
    await expect(message(page, "Спасибо за приглашение")).toBeVisible();
    await guest.screenshot({ path: info.outputPath("guest.png") });

    await page.getByRole("button", { name: "Участники группы" }).click();
    await page.getByRole("button", { name: "Удалить Юки", exact: true }).click();
    await page.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(guest.getByText(/Гостевой доступ завершён/)).toBeVisible();
    expect((await guest.request.get(new URL(currentHref, service.origin).href)).ok()).toBe(false);
    await page.keyboard.press("Escape");
    await expect(message(page, "Спасибо за приглашение")).toBeVisible();
  } finally {
    try { await guestContext.close(); } finally { await service.close(); }
  }
});
