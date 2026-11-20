#!/usr/bin/env bash
set -euo pipefail

app=${1:?Application required}
revision=${2:?Full commit SHA required}
case "$app" in
  tsudoi|hibiki|douga|asobiba) ;;
  *) echo 'Unknown application' >&2; exit 2 ;;
esac
if [[ ! "$revision" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Expected a full commit SHA' >&2
  exit 2
fi

cd -- "$(dirname -- "$0")"
exec 9>.release.lock
if ! flock -w 600 9; then
  echo 'Timed out waiting for another application release' >&2
  exit 1
fi

services=("$app")
if [[ "$app" == hibiki ]]; then
  services+=(hibiki-worker)
fi
setting=${app^^}_TAG
previous=$(sed -n "s/^$setting=//p" images.env)
export "$setting=$revision"
compose=(docker compose --env-file images.env)
"${compose[@]}" pull "${services[@]}"

if [[ "$previous" == "$revision" ]]; then
  "${compose[@]}" up -d --wait --wait-timeout 100 "${services[@]}"
  printf 'Already released %s %s\n' "$app" "$revision"
  exit 0
fi

next_state=
recover() {
  result=$?
  if [[ -n "$next_state" && -f "$next_state" ]]; then
    unlink "$next_state"
  fi
  if [[ "$result" != 0 && "$previous" =~ ^[a-f0-9]{40}$ ]]; then
    echo "Starting previous image $previous against the current database" >&2
    export "$setting=$previous"
    "${compose[@]}" up -d --wait --wait-timeout 100 "${services[@]}" || {
      echo "Previous image did not recover. Inspect logs and backups/$app before restoring SQLite." >&2
    }
  fi
}
trap recover EXIT
"${compose[@]}" stop "${services[@]}"

# The server and any worker are quiescent while SQLite is backed up.
shopt -s nullglob
for database in data/"$app"/*.db data/"$app"/*.sqlite; do
  backup_dir=backups/$app/$(date -u +%Y%m%dT%H%M%SZ)-${previous:-initial}
  install -d -m 700 "$backup_dir"
  sqlite3 "$database" -cmd '.timeout 5000' ".backup '$backup_dir/${database##*/}'"
done

if [[ "$app" == douga ]]; then
  "${compose[@]}" run --rm --no-deps douga node node_modules/prisma/build/index.js db push
fi

"${compose[@]}" up -d --wait --wait-timeout 100 "${services[@]}"

umask 077
next_state=$(mktemp ./images.env.XXXXXX)
awk -v key="$setting" 'index($0,key "=") != 1' images.env > "$next_state"
printf '%s=%s\n' "$setting" "$revision" >> "$next_state"
mv -- "$next_state" images.env
printf 'Released %s %s\n' "$app" "$revision"
