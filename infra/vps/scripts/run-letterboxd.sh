#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/infra/vps/.env"
STATE_FILE_DEFAULT="$REPO_ROOT/app/.lastSeen"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:?missing DISCORD_WEBHOOK_URL}"
if [[ -z "${USERNAME:-}" && -n "${LETTERBOXD_USERNAME:-}" ]]; then
  USERNAME="$LETTERBOXD_USERNAME"
fi
if [[ -z "${USERNAME:-}" ]]; then
  echo "missing USERNAME (comma-separated Letterboxd names)" >&2
  exit 1
fi
export USERNAME
# keep legacy env populated for older revisions
export LETTERBOXD_USERNAME="${LETTERBOXD_USERNAME:-$USERNAME}"
export STATE_FILE="${STATE_FILE:-$STATE_FILE_DEFAULT}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export FORCE_MOST_RECENT="${FORCE_MOST_RECENT:-false}"
export MAX_POSTS="${MAX_POSTS:-1}"

cd "$REPO_ROOT/app"
node -e 'require("./handler").handler().then(r=>{console.log("[letterboxd]",r);}).catch(e=>{console.error(e);process.exitCode=1;})'
