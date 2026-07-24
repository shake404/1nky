#!/usr/bin/env bash
# =============================================================================
# 1NKY — deploy to the droplet
# =============================================================================
#
#   DROPLET_HOST=<reserved-ip-or-hostname> ./infra/deploy/deploy.sh
#
# Strategy: git on the droplet. The box pulls the repo itself and builds the
# images locally. No registry, no image tarballs over the wire, no CI
# credentials on the server. For a single 2GB box this is the right amount of
# machinery — reach for a registry when you have a second box, not before.
#
# What happens:
#   1. ssh reachability + docker preflight
#   2. clone (first run) or fetch+reset (subsequent runs) into /opt/1nky
#   3. ship .env over ssh at mode 0600, if you have one locally
#   4. docker compose up -d --build
#   5. wait for health and report
#
# SECRETS: the local `.env` is streamed over the ssh channel into a 0600 file.
# It is never echoed, never passed as a command-line argument (which would be
# visible in the droplet's process list), and never committed — the root
# .gitignore covers it. If you would rather manage it on the box by hand, set
# SKIP_ENV=1 and this step is skipped entirely.
# =============================================================================

set -euo pipefail

DROPLET_HOST="${DROPLET_HOST:-}"
DROPLET_USER="${DROPLET_USER:-root}"
APP_DIR="${APP_DIR:-/opt/1nky}"
GIT_REMOTE="${GIT_REMOTE:-}"
GIT_REF="${GIT_REF:-main}"
COMPOSE_PROFILE="${COMPOSE_PROFILE:-full}"
SKIP_ENV="${SKIP_ENV:-0}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

c_ok()   { printf '\033[32m  ok\033[0m   %s\n' "$*"; }
c_info() { printf '\033[90m  ..\033[0m   %s\n' "$*"; }
c_warn() { printf '\033[33m  !!\033[0m   %s\n' "$*" >&2; }
c_die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
c_head() { printf '\n\033[1m%s\033[0m\n' "$*"; }

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
remote() { ssh "${SSH_OPTS[@]}" "${DROPLET_USER}@${DROPLET_HOST}" "$@"; }

# --- preflight ---------------------------------------------------------------
c_head "preflight"

[[ -n "$DROPLET_HOST" ]] || c_die \
  "DROPLET_HOST is not set.
   Use the RESERVED ip that provision.sh printed, e.g.
     DROPLET_HOST=203.0.113.10 ./infra/deploy/deploy.sh"

if [[ -z "$GIT_REMOTE" ]]; then
  GIT_REMOTE="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  [[ -n "$GIT_REMOTE" ]] || c_die \
    "could not determine the git remote. Set it explicitly:
     GIT_REMOTE=git@github.com:you/1nky.git DROPLET_HOST=... ./infra/deploy/deploy.sh"
fi
c_ok "remote  $GIT_REMOTE ($GIT_REF)"

remote true 2>/dev/null || c_die \
  "cannot ssh to ${DROPLET_USER}@${DROPLET_HOST}.
   Check the ip, and that your key is on the droplet."
c_ok "ssh     ${DROPLET_USER}@${DROPLET_HOST}"

remote 'command -v docker >/dev/null && docker compose version >/dev/null' 2>/dev/null || c_die \
  "docker + compose plugin not available on the droplet.
   Has cloud-init finished?  ssh ${DROPLET_USER}@${DROPLET_HOST} cloud-init status --long"
c_ok "docker  present"

# --- source ------------------------------------------------------------------
c_head "source -> ${APP_DIR}"

# Note the deliberate `reset --hard`: the droplet is not a place to edit code.
# Anything changed on the box is lost, which is the point — the repo is the
# only source of truth for configuration.
remote APP_DIR="$APP_DIR" GIT_REMOTE="$GIT_REMOTE" GIT_REF="$GIT_REF" bash -s <<'REMOTE_SOURCE'
set -euo pipefail
mkdir -p "$APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  echo "  .. fetching"
  git -C "$APP_DIR" remote set-url origin "$GIT_REMOTE"
  git -C "$APP_DIR" fetch --prune origin
  git -C "$APP_DIR" checkout -q "$GIT_REF"
  git -C "$APP_DIR" reset --hard "origin/$GIT_REF"
else
  echo "  .. cloning"
  git clone --branch "$GIT_REF" "$GIT_REMOTE" "$APP_DIR"
fi
echo "  ok   $(git -C "$APP_DIR" rev-parse --short HEAD)  $(git -C "$APP_DIR" log -1 --format=%s)"
REMOTE_SOURCE

# --- env ---------------------------------------------------------------------
c_head "environment"

if [[ "$SKIP_ENV" == "1" ]]; then
  c_info "SKIP_ENV=1 — leaving ${APP_DIR}/infra/.env alone"
elif [[ -f "${REPO_ROOT}/.env" ]]; then
  # Piped over stdin so the contents never appear in argv or in any shell
  # history, local or remote. Written 0600 before any byte lands in it.
  remote "install -m 600 /dev/null '${APP_DIR}/infra/.env' && cat > '${APP_DIR}/infra/.env'" \
    < "${REPO_ROOT}/.env"
  c_ok "shipped .env (mode 0600, contents not logged)"
else
  c_warn "no local .env found at ${REPO_ROOT}/.env"
  c_warn "the stack will start with compose defaults — R2 credentials will be empty"
  c_info "fix: cp .env.example .env, fill it in, re-run. Or set SKIP_ENV=1 and"
  c_info "     create ${APP_DIR}/infra/.env on the droplet by hand."
fi

# --- build + up --------------------------------------------------------------
c_head "docker compose up (profile: ${COMPOSE_PROFILE})"

remote APP_DIR="$APP_DIR" COMPOSE_PROFILE="$COMPOSE_PROFILE" bash -s <<'REMOTE_UP'
set -euo pipefail
cd "$APP_DIR/infra"
docker compose --profile "$COMPOSE_PROFILE" pull --ignore-buildable || true
docker compose --profile "$COMPOSE_PROFILE" up -d --build --remove-orphans
# Reclaim the layers the rebuild just orphaned. On an 80GB disk with a Node
# image this adds up faster than you would think.
docker image prune -f >/dev/null 2>&1 || true
REMOTE_UP

c_ok "compose applied"

# --- verify ------------------------------------------------------------------
c_head "health"

remote APP_DIR="$APP_DIR" COMPOSE_PROFILE="$COMPOSE_PROFILE" bash -s <<'REMOTE_HEALTH'
set -uo pipefail
cd "$APP_DIR/infra"
for _ in $(seq 1 30); do
  unhealthy="$(docker compose --profile "$COMPOSE_PROFILE" ps --format '{{.Service}} {{.State}} {{.Health}}' \
    | awk '$3 == "starting" || $3 == "unhealthy" || $2 != "running" {print $1}')"
  [[ -z "$unhealthy" ]] && break
  sleep 5
done
echo
docker compose --profile "$COMPOSE_PROFILE" ps
echo
if [[ -n "${unhealthy:-}" ]]; then
  echo "STILL NOT HEALTHY: $unhealthy"
  exit 1
fi
REMOTE_HEALTH

cat <<EOF

deployed.

  smoke test the relay from your workstation:

    cd infra/scripts && pnpm install
    RELAY_WS_URL=ws://${DROPLET_HOST}/relay node relay-smoke.mjs

    (that goes through Caddy. strfry's own port is bound to 127.0.0.1 on the
     droplet and is not reachable from outside, which is intended.)

  tail service output:

    ssh ${DROPLET_USER}@${DROPLET_HOST} 'cd ${APP_DIR}/infra && docker compose logs -f --tail=50'

    Expect the write policy's "kind=<n> accept|reject" lines and nothing that
    identifies a visitor. If you see a request log, that is a bug — see the
    no-logs policy block at the top of infra/docker-compose.yml.

  rollback:

    GIT_REF=<previous-sha> DROPLET_HOST=${DROPLET_HOST} ./infra/deploy/deploy.sh

    The relay's LMDB volume and Postgres volume are untouched by a redeploy, so
    a rollback loses no events.

EOF
