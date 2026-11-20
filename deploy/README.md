# Четыре проекта на одном VPS

`compose.yaml` подключает четыре образа и воркер Hibiki. Caddy публикует Tsudoi на `443`, Hibiki на `8443`, Douga на `8444` и Asobiba на `8445`. На `80` Caddy обслуживает проверку домена для ACME и редиректы. Для первого запуска подключите техническое DNS-имя к публичному IP VPS.

Скопируйте `compose.yaml`, `Caddyfile`, `receive.sh` и `release.sh` в `/srv/friends` на машине с Docker Compose v2 и SQLite CLI. Создайте каталоги `data/{tsudoi,hibiki,douga,asobiba}` для UID/GID `1000` и доступные администратору `env/`, `backups/`. В `images.env` задайте `IMAGE_OWNER` с владельцем пакетов GHCR.

Рабочие файлы среды создаются на VPS:

| Файл | Параметры |
|---|---|
| `env/caddy.env` | `PUBLIC_HOST` и `FRIENDS_PASSWORD_HASH` из `caddy hash-password` |
| `env/tsudoi.env` | `TSUDOI_ORIGIN=https://<host>`, `TSUDOI_TRUST_PROXY=172.26.10.2` |
| `env/hibiki.env` | `PUBLIC_URL=https://<host>:8443` |
| `env/douga.env` | `AUTH_URL=https://<host>:8444`, `DOUGA_PUBLIC_URL=https://<host>:8444`, `AUTH_TRUST_HOST=true`, случайный `AUTH_SECRET`, `DATABASE_URL=file:/app/storage/douga.db` |
| `env/asobiba.env` | `PUBLIC_URL=https://<host>:8445`, `COOKIE_SECURE=1`, `DOUGA_URL=http://douga:3000` |

Доступ к сайтам требует общей учётной записи `friends` на Caddy, затем личного аккаунта приложения. MCP использует собственные токены, а `/health` Tsudoi доступен для проверки сети. Контейнеры закрывают веб-регистрацию и гостевой вход через `PROVISIONED_ACCOUNTS_ONLY=1`.

Создавайте аккаунты через `docker compose --env-file images.env exec -T <app> node --import tsx scripts/provision-account.ts <login> <role>`, передавая пароль через stdin. Для Douga добавьте перед `node` переменную `TSX_TSCONFIG_PATH=tsconfig.mcp.json` с помощью `exec -e`. Роли Asobiba — `admin` и `user`, роли Douga и Tsudoi — `admin` и `member`. У Hibiki опустите аргумент роли. Скрипты сохраняют хеши и оставляют существующие записи при повторном запуске.

Запустите Caddy командой `docker compose --env-file images.env up -d caddy`. Для каждого репозитория добавьте переменную `DEPLOY_HOST` и секреты `DEPLOY_SSH_KEY` и `DEPLOY_SSH_KNOWN_HOSTS`. На VPS привяжите публичный ключ к одному приложению через запись `restrict,command="/srv/friends/receive.sh <app>"` в `authorized_keys`. `receive.sh` читает временный токен GHCR из stdin, скачивает образ и удаляет конфигурацию входа после выпуска.

Запустите `gh workflow run production.yml --ref main` из репозитория приложения. Для запуска после merge установите `AUTO_DEPLOY=true`. Активные коммиты сохраняются в `images.env` после проверки контейнера. Внешний HTTPS и пользовательский сценарий сверяются после выхода на сервер. Douga компилирует HTML и публикует интерактивные снимки без фоновой генерации кадров. SQLite-копии лежат в `backups/` и не включают медиа. Если нужен откат, используйте `bash release.sh <app> <previous-sha>` с доступом к GHCR и проверьте совместимость текущей базы с версией приложения.
