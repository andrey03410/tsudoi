# История

| Дата | Изменение |
|---|---|
| 2026-11-19 | Инициализация Tsudoi. Добавлены Node.js workspaces, базовый запуск, слой знаний и постановка [01-mvp](features/01-mvp/README.md) для согласования. |
| 2026-11-19 | Влит [MVP мессенджера](features/01-mvp/README.md) через [PR #1](https://github.com/andrey03410/tsudoi/pull/1). Инвайты, чаты, временный доступ гостей, медиа и восстановление переписки. [Проверки](features/01-mvp/verify.md) |
| 2026-11-20 | [Деплой на VPS](features/02-docker-deploy/README.md) через [PR #2](https://github.com/andrey03410/tsudoi/pull/2). Docker, GitHub Actions и вход по созданным аккаунтам. |
| 2026-11-20 | [Проверка воркера Hibiki](features/03-hibiki-worker-health/README.md) через [PR #3](https://github.com/andrey03410/tsudoi/pull/3). Compose ждёт готовность процесса и допускает холодное скачивание образов в очереди релизов. |
| 2026-11-20 | [Страницы входа без общего пароля](features/04-public-login/README.md) через [PR #4](https://github.com/andrey03410/tsudoi/pull/4). Caddy показывает вход приложения по HTTPS. |

Заготовка проверена на Node.js 24.21.0. Успешно выполнены `npm ci`, `npm run build` и `npm run typecheck`. В `npm run dev` и `npm start` HTTP-проверка получила страницу Tsudoi, клиентский модуль и ответ `/health`. Для dev проверены прямой запрос к Fastify и запрос через Vite.
