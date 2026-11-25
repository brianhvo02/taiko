#!/usr/bin/env bash
# The owner's deploy, run from the repo: npm run server:deploy
# Builds the server image, ships it to the NAS over ssh, writes the generic compose file, (re)starts the service,
# removes the images of earlier deploys and
# adds the /taiko/* route to Caddy. The NAS's own settings stay on the NAS, in ~/taiko-server/.env and
# ~/taiko-server/compose.override.yaml (the proxy's network, extra mounts); this script never writes either.
# Adapted from Seikou's server/deploy/deploy.sh.
#
# Needs bash (Git Bash on Windows) and ssh access to the NAS. With Docker running on this machine the image is built
# here and shipped; without it, the NAS builds the image itself.
#
# Run on the NAS itself (TAIKO_NAS_HOST is this machine's own name, or "local"), nothing goes over ssh: the image
# is built here and the same steps run in this shell.
#
# Settings, from the environment or from .env.local at the repo root (gitignored; KEY=value lines):
#   TAIKO_NAS_HOST    the NAS's ssh host (required)
#   TAIKO_CADDY_SITE  the Caddy site that gets the /taiko/* route, as written in the Caddyfile, for example
#                     https://nas.example.com. Leave it unset to skip Caddy and route the server yourself.
#
# A deploy refuses while the NAS's .env lacks PUBLIC_BASE, LIBRARY_MOUNT or LIBRARY_ROOTS, so a NAS that isn't set up
# can't take a running server down.
#
# With one of these it deploys nothing and runs the command on the running server:
#   --invite [--days N]     make a pairing code and print it with its link
#   --devices               list paired devices
#   --unpair <id or name>   remove one
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
REMOTE_DIR='~/taiko-server'
ROUTE='/taiko'

# Reads KEY from .env.local unless the environment already sets it. Plain KEY=value lines; surrounding quotes go.
setting() {
  local key="$1" line value
  if [ -n "${!key:-}" ]; then printf '%s' "${!key}"; return; fi
  [ -f "$REPO/.env.local" ] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$key=" "$REPO/.env.local" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    \"*\") value="${value:1:${#value}-2}" ;;
    \'*\') value="${value:1:${#value}-2}" ;;
  esac
  printf '%s' "$value"
}

HOST="$(setting TAIKO_NAS_HOST)"
if [ -z "$HOST" ]; then
  echo "Set TAIKO_NAS_HOST (the NAS's ssh host) in the environment or in $REPO/.env.local." >&2
  exit 1
fi
# A host that starts with - would be read as an ssh option (every call also passes it after --).
case "$HOST" in
  -*) echo "TAIKO_NAS_HOST must not start with '-': $HOST" >&2; exit 1 ;;
esac

# On the NAS itself there is nothing to ssh to (and a machine often can't ssh to its own name).
LOCAL=''
case "$HOST" in
  local|localhost|"$(hostname 2>/dev/null)"|"$(hostname -s 2>/dev/null)") LOCAL=1 ;;
esac
WHERE="$HOST"
if [ -n "$LOCAL" ]; then WHERE='this machine'; fi

# Runs a command line on the NAS, with this script's stdin as its stdin: over ssh, or here when this is the NAS.
on_nas() {
  if [ -n "$LOCAL" ]; then bash -c "$1"; else ssh -- "$HOST" "$1"; fi
}

case "${1:-}" in
  --invite|--devices|--unpair)
    COMMAND="${1#--}"
    shift
    # Extra args (such as --days 7, or a device name) pass through, quoted for the remote shell.
    ARGS=""
    if [ $# -gt 0 ]; then ARGS="$(printf ' %q' "$@")"; fi
    on_nas "docker exec taiko-server node /app/server.mjs $COMMAND$ARGS"
    exit
    ;;
  "") ;;
  *)
    echo "Unknown argument: $1 (expected --invite, --devices or --unpair, or nothing to deploy)" >&2
    exit 1
    ;;
esac

CADDY_SITE="$(setting TAIKO_CADDY_SITE)"
# The Caddyfile's site address has no trailing slash (https://nas.example.com, not https://nas.example.com/).
while [ "${CADDY_SITE%/}" != "$CADDY_SITE" ]; do CADDY_SITE="${CADDY_SITE%/}"; done

# Before anything is built or shipped: the compose file takes its values from the NAS's .env, so without them the
# new service would not start. Only key names and one yes/no come back, never values.
echo "==> Checking $REMOTE_DIR/.env on $WHERE"
env_report() {
  on_nas "bash -s -- $(printf '%q' "${CADDY_SITE:+$CADDY_SITE$ROUTE/api/}")" <<'SH'
# Prints the names of the keys .env gives a non-empty value, one per line, then "base-matches" when PUBLIC_BASE is
# the address given as the argument.
f="$HOME/taiko-server/.env"
test -f "$f" || exit 0
awk -v want="$1" '
  /^[ \t]*(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=/ {
    line = $0; sub(/\r$/, "", line); sub(/^[ \t]*(export[ \t]+)?/, "", line)
    k = substr(line, 1, index(line, "=") - 1); sub(/[ \t]+$/, "", k)
    v = substr(line, index(line, "=") + 1); gsub(/^[ \t]+|[ \t]+$/, "", v)
    if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2)
    if (v != "") print k
    if (k == "PUBLIC_BASE" && want != "" && v == want) print "base-matches"
  }' "$f"
SH
}
ENV_REPORT="$(env_report)" || { echo "Could not read $REMOTE_DIR/.env on $WHERE." >&2; exit 1; }
for key in PUBLIC_BASE LIBRARY_MOUNT LIBRARY_ROOTS; do
  if ! printf '%s\n' "$ENV_REPORT" | grep -qx "$key"; then
    echo "The NAS's .env has no $key: set it in $REMOTE_DIR/.env there (see server/deploy/.env.example and docs/self-hosting.md)." >&2
    exit 1
  fi
done
if [ -n "$CADDY_SITE" ] && ! printf '%s\n' "$ENV_REPORT" | grep -qx 'base-matches'; then
  echo "The NAS's PUBLIC_BASE is not $CADDY_SITE$ROUTE/api/, the address this deploy routes. Set it to that in $REMOTE_DIR/.env, or unset TAIKO_CADDY_SITE and route the server yourself." >&2
  exit 1
fi

cd "$REPO"

# A repo with no commits yet still deploys, tagged "dev".
TAG="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then TAG="$TAG-dirty"; fi

echo "==> Bundling the server"
npm run server:build

if [ -n "$LOCAL" ]; then
  echo "==> Building taiko-server:$TAG on this machine, which is the NAS"
  docker build -t "taiko-server:$TAG" -t taiko-server:latest -f server/Dockerfile server
elif docker info >/dev/null 2>&1; then
  echo "==> Building taiko-server:$TAG for linux/amd64"
  docker buildx build --platform linux/amd64 --load \
    -t "taiko-server:$TAG" -t taiko-server:latest \
    -f server/Dockerfile server

  echo "==> Shipping the image to $HOST"
  docker save "taiko-server:$TAG" taiko-server:latest | gzip | ssh -- "$HOST" 'gunzip | docker load'
else
  # No Docker running here: the image is one bundled file on a Node base, so the NAS can build it itself from the
  # Dockerfile and the bundle, sent as the build context.
  echo "==> Docker isn't running on this machine: building taiko-server:$TAG on $HOST"
  tar -C server -cf - Dockerfile dist/server.mjs | gzip \
    | ssh -- "$HOST" "gunzip | docker build -t $(printf '%q' "taiko-server:$TAG") -t taiko-server:latest -"
fi

echo "==> Writing $REMOTE_DIR/compose.yaml and starting the service"
on_nas "mkdir -p $REMOTE_DIR && cat > $REMOTE_DIR/compose.yaml" < server/deploy/compose.yaml
COMPOSE_FILES="-f compose.yaml"
# The NAS's own networks and mounts. With -f, Compose no longer picks it up by itself, so name it.
if on_nas "test -e $REMOTE_DIR/compose.override.yaml" < /dev/null; then
  COMPOSE_FILES="$COMPOSE_FILES -f compose.override.yaml"
  echo "    with compose.override.yaml"
fi
# The image just shipped, whatever TAIKO_IMAGE the .env names (the shell's value wins over .env in Compose).
# --no-build: the compose file's build context is the repo, which the NAS doesn't have.
on_nas "cd $REMOTE_DIR && TAIKO_IMAGE=taiko-server:latest docker compose $COMPOSE_FILES up -d --no-build" < /dev/null
echo "    A manual restart must name the same files: cd $REMOTE_DIR && docker compose $COMPOSE_FILES up -d --no-build"

# Every deploy tags the image with its commit, so the earlier ones pile up on the NAS. Now that the service runs
# the new one, the others go: every taiko-server tag but this deploy's and "latest". A tag that can't be removed
# (an image still in use) is left, and never fails the deploy.
echo "==> Removing earlier taiko-server images from $WHERE"
on_nas "bash -s -- $(printf '%q' "$TAG")" <<'SH' || echo "    Could not tidy the old images; the deploy itself is done."
keep="$1"
docker images taiko-server --format '{{.Tag}}' | while read -r tag; do
  case "$tag" in
    latest|"$keep"|'<none>'|'') ;;
    *) docker rmi "taiko-server:$tag" >/dev/null 2>&1 && echo "    removed taiko-server:$tag" || echo "    kept taiko-server:$tag (still in use)" ;;
  esac
done
SH

if [ -n "$CADDY_SITE" ]; then
  echo "==> Routing $ROUTE/* in Caddy"
  on_nas "bash -s -- $(printf '%q' "$CADDY_SITE")" < server/deploy/caddy-route.sh
  echo "==> Done: $CADDY_SITE$ROUTE/api/health"
else
  echo "==> Done. TAIKO_CADDY_SITE is not set, so no proxy route was added: point your HTTPS proxy at the container's port 8080."
fi
echo "    Pair a device: npm run server:deploy -- --invite"
