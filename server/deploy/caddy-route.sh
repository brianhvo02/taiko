#!/usr/bin/env bash
# Runs on the NAS (deploy.sh pipes it over SSH with the site as its argument, from TAIKO_CADDY_SITE).
# Adds the /taiko/* route to that site in Caddy's Caddyfile if it is missing, keeping a backup, then validates and
# reloads Caddy. Never restarts Caddy. Adapted from Seikou's server/deploy/caddy-route.sh.
#   bash -s -- https://nas.example.com < caddy-route.sh
#
# The route is `handle`, not `handle_path`: Taiko's server answers under the path in its PUBLIC_BASE
# (/taiko/api/), so the /taiko prefix must reach it unchanged.
# Caddy reaches the server by its container name, so the two must share a Docker network: attach the taiko-server
# service to Caddy's network in ~/taiko-server/compose.override.yaml on the NAS.
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "caddy-route.sh: no site given (the Caddyfile's site address, e.g. https://nas.example.com)." >&2
  exit 1
fi

CADDY_DIR="$HOME/caddy"
CADDYFILE="$CADDY_DIR/Caddyfile"
SITE="$1"
CONFIG=(--config /etc/caddy/Caddyfile --adapter caddyfile)

if [ ! -f "$CADDYFILE" ]; then
  echo "caddy-route.sh: no Caddyfile at $CADDYFILE; nothing changed." >&2
  exit 1
fi

if grep -q 'handle /taiko/\*' "$CADDYFILE"; then
  # Still validate and reload, so an interrupted earlier run can't leave the route unloaded.
  echo "Caddyfile already routes /taiko/*; validating and reloading."
  docker exec caddy caddy validate "${CONFIG[@]}"
else
  BACKUP="$CADDY_DIR/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$CADDYFILE" "$BACKUP"
  echo "Backed up the Caddyfile to $BACKUP"

  # Insert the block before the line that closes the site block (brace depth back to 0).
  # If the site closes any other way (e.g. "}}"), give up rather than run on into another site.
  NEW="$(mktemp)"
  awk -v site="$SITE {" '
    BEGIN { inside = 0; done = 0 }
    {
      line = $0
      if (!done && !inside && line == site) { inside = 1; depth = 0 }
      if (inside) {
        code = line; sub(/#.*/, "", code)
        opens = gsub(/\{/, "{", code); closes = gsub(/\}/, "}", code)
        if (depth + opens - closes <= 0 && closes > 0) {
          if (depth + opens - closes < 0 || code !~ /^[ \t]*\}[ \t]*$/) exit 1
          print ""
          print "  handle /taiko/* {"
          print "    reverse_proxy taiko-server:8080"
          print "  }"
          inside = 0; done = 1
        }
        depth += opens - closes
      }
      print line
    }
    END { if (!done) exit 1 }
  ' "$CADDYFILE" > "$NEW" || { rm -f "$NEW"; echo "No line closing the site block $SITE on its own; Caddyfile unchanged." >&2; exit 1; }

  # Overwrite in place so the file keeps its inode and permissions.
  cat "$NEW" > "$CADDYFILE"
  rm -f "$NEW"

  if ! docker exec caddy caddy validate "${CONFIG[@]}"; then
    cat "$BACKUP" > "$CADDYFILE"
    echo "Caddy rejected the new Caddyfile; restored $BACKUP." >&2
    exit 1
  fi
fi

docker exec caddy caddy reload "${CONFIG[@]}"
echo "Caddy reloaded with the /taiko/* route."
