#!/usr/bin/env bash
set -euo pipefail

# Each repository key is bound to one service in authorized_keys.
app=${1:?Application required}
command=${SSH_ORIGINAL_COMMAND:-}
if [[ ! "$command" =~ ^release\ ([a-f0-9]{40})\ ([a-zA-Z0-9-]+)$ ]]; then
  echo 'Expected release <commit SHA> <registry user>' >&2
  exit 2
fi
revision=${BASH_REMATCH[1]}
registry_user=${BASH_REMATCH[2]}

umask 077
DOCKER_CONFIG=$(mktemp -d)
export DOCKER_CONFIG
trap 'rm -rf -- "$DOCKER_CONFIG"' EXIT
read -r registry_token
printf '%s' "$registry_token" | docker login ghcr.io --username "$registry_user" --password-stdin >/dev/null
unset registry_token
bash "$(dirname -- "$0")/release.sh" "$app" "$revision"
