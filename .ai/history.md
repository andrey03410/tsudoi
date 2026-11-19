# История

| Дата | Изменение |
|---|---|
| 2026-11-19 | Инициализация Tsudoi. Добавлены Node.js workspaces, базовый запуск, слой знаний и постановка [01-mvp](features/01-mvp/README.md) для согласования. |

Заготовка проверена на Node.js 24.21.0. Успешно выполнены `npm ci`, `npm run build` и `npm run typecheck`. В `npm run dev` и `npm start` HTTP-проверка получила страницу Tsudoi, клиентский модуль и ответ `/health`. Для dev проверены прямой запрос к Fastify и запрос через Vite.
