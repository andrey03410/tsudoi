# Проверка MVP

Проверено на Node.js 24.21.0. HTTP-тесты и браузерные сценарии используют отдельные временные базы и синтетические учётные записи.

| Проверка | Команда | Результат |
|---|---|---|
| Установка | `npm ci` | Из lockfile. Prisma Client сгенерирован. |
| Тесты | `npm test` | 25 из 25. Авторизация, права гостя, синхронизация, вложения и восстановление SQLite. |
| Сборка | `npm run build` | Сервер и веб-клиент собраны. |
| Типы | `npm run typecheck` | Ошибок нет. |
| Браузер | `npm run test:e2e` | 4 из 4 в Chromium и WebKit с параметрами iPhone 13. |
| Точки запуска | `npm run dev`, `npm start` | HTML, `/health`, вход с Origin и авторизованный WebSocket в обоих режимах. |

## Что проверено в браузере

- Администратор выдаёт инвайт. Независимая сессия создаёт аккаунт и получает личный диалог, непрочитанное и новые сообщения в реальном времени.
- После принудительного разрыва WebSocket браузер восстанавливает пропущенное сообщение и реакцию. При потере HTTP-подтверждения отправки файл и сообщение остаются в одном экземпляре после повтора с тем же `clientId`.
- Стикер загружается из локального набора. Загруженный GIF воспроизводится и останавливается. Вложение скачивается и остаётся доступным после перезапуска сервера.
- Гость входит по одноразовой ссылке, видит переписку с момента вступления и отправляет сообщение. Старый файл закрыт. Отзыв закрывает уже открытую вкладку гостя и прямую ссылку на доступный ранее файл. Участники по-прежнему видят его прежнее сообщение.
- Мобильное переключение между списком и чатом проверено с touch и viewport iPhone. Дополнительно проверена отправка при недоступном `crypto.randomUUID`, как на локальном HTTP-адресе. Проверка выполнена в эмуляции, без физического телефона.

Снимки и трассы создаёт Playwright в `test-results/`. Подборка скриншотов хранится локально в `storage/verification/01-mvp/`.

## Ревью и исправления

Независимо проверены аккаунты, инвайты, сессии, чаты, работа диска и веб-клиент. Исправлены Secure cookies на HTTPS, учёт адресов за явно доверенным прокси, офлайн-истечение гостевого срока, старые реакции при подгрузке истории, окончательный отказ отправки, статус уже использованной ссылки и отправка по локальному HTTP. Добавлена очистка забытых загрузок и пометка гостевых реакций. Проверка точек входа выявила замену Host в dev-прокси, исправленную сохранением Host.

## Что посмотреть руками

1. Войти администратором, выдать инвайт, создать второй аккаунт в приватном окне.
2. Отправить сообщение, стикер и GIF, добавить реакцию. На узком экране вернуться к списку и снова открыть чат.
3. Создать группу, пригласить гостя и отозвать доступ из списка участников, оставив вкладку гостя открытой.

## Иллюстрации

Встроенный ImageGen подготовил набор, поставляемый в `apps/web/public/stickers/`, и иллюстрацию `apps/web/public/landscape.webp`. Лист экспортирован в шесть PNG, иллюстрация сжата в WebP.

<details>
<summary>Промпты ImageGen</summary>

```text
Generate ONE compact sprite sheet of six original transparent chat stickers for a minimalist Japanese-influenced messenger called Tsudoi. A wide 3 columns x 2 rows landscape sprite sheet, exactly six equal cells laid out on a mathematically regular 3x2 grid, centers at x 16.67%,50%,83.33% and y 25%,75%. No lines, no labels, no text or lettering, no shadow outside each cell, alpha empty canvas. Keep every illustrated part within the middle 68% width and middle 68% height of its own cell with very generous empty gutters to allow exact equal-cell cutting. All six depict same original warm ivory shiba-like puppy with ink facial details, warm apricot rounded ears and very dark teal accents, simple expressive hand-inked kawaii illustrations with white keyline, flat Japanese stationery style. No existing characters, IP or brand. In reading order: top left puppy raises one paw waving hello with tiny motion lines; top middle puppy celebrates with two confetti accents; top right puppy hugs a coral heart; bottom left puppy holds a cup of green tea; bottom middle puppy laughs with closed eyes; bottom right puppy sleeping curled up with one tiny pale teal moon without lettering. Design for clarity at a 64px chat picker size, compact centered elements, simple rich flat color and clean details. Full transparent background.
```

```text
A wide, horizontal original illustration for the sign-in panel of Tsudoi, a thoughtful private chat app. Authentic Japanese landscape visual language with layered distant mountain silhouettes, pine-covered ridges and still lake surface in ink green and rich muted evergreen, warm soft paper sky, small muted vermilion sun. Quiet early morning with subtle tactile printmaking texture, contemporary woodblock art, simple visually legible shapes, minimal detail, broad landscape depth. Crisp crafted composition. No people, no buildings needed, no text, letters, borders, or UI. Broad proportions, 3:2 or wider, natural palette with enough green toward the bottom to integrate into a dark forest-teal page.
```

</details>
