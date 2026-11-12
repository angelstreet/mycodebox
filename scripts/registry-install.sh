#!/bin/sh
# Install the lease registry files on the registry host (bug-73b62192): the registry (node scripts/lease-serve.js in
# ~/mycodebox-lease on the registry host) is NOT part of the ghosty deploy, so a merged lease-service.js change stayed unused
# until installed by hand. Idempotent: a file equal to the repo copy is left alone. Steps per docs/REFERENCE.md "The registry
# process is NOT in the ghosty deploy": no deploy running, timestamped backup, node --check, copy, graceful restart, claim/release
# round trip on a free resource, rollback of every file if the round trip fails.
# Usage: scripts/registry-install.sh [--dry-run]   env: REGISTRY_SSH (default: VPT_LEASE_SSH_TARGET or proxmox), REGISTRY_DIR
# (default ~/mycodebox-lease), REGISTRY_ENV (default node1-vpt), REGISTRY_PROBE (resource for the round trip, default: first free of REGISTRY_PROBES).
# Exit: 0 installed or nothing to do, 3 a deploy is running (try again later), 1 failed (rolled back).
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
SSH_T=${REGISTRY_SSH:-${VPT_LEASE_SSH_TARGET:-proxmox}}
DIR=${REGISTRY_DIR:-mycodebox-lease}
ENVN=${REGISTRY_ENV:-node1-vpt}
PROBES=${REGISTRY_PROBES:-"vpt-lenovo4/device1 vpt-mf1/device2 vpt-pi1/device5"}
PROC=${REGISTRY_PROC:-[^ ]*node scripts/lease-serve\.js}   # regexp of the registry command line (tests override it)
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
FILES="lease-service.js lease-routes.js catchup-supersede.js lease-equivalence.js scripts/lease-serve.js"
# the lane runs with a minimal PATH (no ~/.local/bin): find the client, and fail closed without it (the first two lane runs rolled back on this)
VL=${VPT_LEASE_BIN:-$(command -v vpt-lease 2>/dev/null)}
[ -n "$VL" ] || for c in "$HOME/bin/vpt-lease" "$HOME/.local/bin/vpt-lease"; do [ -x "$c" ] && { VL=$c; break; }; done
[ -n "$VL" ] || { echo "registry-install: vpt-lease client not found" >&2; exit 1; }
rssh() { ssh -o ControlPath=none -o ConnectTimeout=10 "$SSH_T" "$@"; }
CHANGED=""
for f in $FILES; do
  [ -f "$HERE/$f" ] || continue
  if rssh "cat ~/$DIR/$f" 2>/dev/null | cmp -s - "$HERE/$f"; then :; else CHANGED="$CHANGED $f"; fi
done
[ -z "$CHANGED" ] && { echo "registry-install: registry files already match the repo"; exit 0; }
echo "registry-install: changed:$CHANGED"
[ "$DRY" = 1 ] && exit 0
DL=$("$VL" deploy list 2>&1) || { echo "registry-install: cannot read the deploy list: $DL" >&2; exit 1; }
if printf %s "$DL" | grep -q "state=running"; then echo "registry-install: a deploy is running; not installing now" >&2; exit 3; fi
TS=$(date -u +%Y%m%d-%H%M)
for f in $CHANGED; do
  case "$f" in *.js) ext=.js ;; esac
  tmp=/tmp/registry-install.$$.js
  rssh "cat > $tmp" < "$HERE/$f" || exit 1
  rssh "node --check $tmp" || { echo "registry-install: syntax check failed for $f" >&2; rssh "rm -f $tmp"; exit 1; }
  rssh "cd ~/$DIR && cp -p $f $f.bak-$TS-pre-install && cp $tmp $f && rm -f $tmp" || exit 1
done
rollback() { for f in $CHANGED; do rssh "cd ~/$DIR && cp -p $f.bak-$TS-pre-install $f"; done; restart; echo "registry-install: rolled back (backups *.bak-$TS-pre-install)" >&2; }
# The pattern is anchored so the remote shell that runs this (its own command line contains the words) is never the match: the first
# version killed itself and the registry kept running the old code. A restart that does not end in a NEW pid fails (-> rollback).
restart() {
  rssh "sh -s -- '$PROC'" <<'EOS'
pat="^$1\$"
old=$(pgrep -u "$(id -u)" -f "$pat" | head -1)
[ -n "$old" ] && kill "$old"
i=0; while [ -n "$old" ] && [ $i -lt 30 ] && kill -0 "$old" 2>/dev/null; do sleep 1; i=$((i+1)); done
sh ~/bin/mycodebox-lease-serve.sh; sleep 4
new=$(pgrep -u "$(id -u)" -f "$pat" | head -1)
[ -n "$new" ] && [ "$new" != "$old" ]
EOS
}
restart || { echo "registry-install: the registry did not restart onto a new process" >&2; rollback; exit 1; }
OK=0; tries=0; WHY="no probe tried"
# the registry needs a few seconds to load its journal after the restart (the first lane run rolled back on exactly this): retry ~45 s
# WHY keeps the last reason so a rollback says what failed (the first lane runs only printed "rolled back")
while [ "$OK" = 0 ] && [ $tries -lt 15 ]; do
  tries=$((tries+1))
  for p in $PROBES ${REGISTRY_PROBE:-}; do
    CK=$("$VL" check "$ENVN" "$p" 2>&1) || { WHY="check $p not free or failed: $(printf %s "$CK" | head -1 | cut -c1-160)"; continue; }
    CL=$("$VL" claim "$ENVN" "$p" --agent codebox:registry-install --ttl 5 --purpose "registry install round trip" 2>&1); crc=$?
    id=$(printf %s "$CL" | head -1)
    # a lease id is 8 hex chars; an error text such as "denied: ..." starts with a hex letter too, so test the whole word and the exit code
    case "$id" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) [ $crc = 0 ] || id=x ;; esac
    case "$id" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) if "$VL" release "$id" >/dev/null 2>&1; then OK=1; else WHY="release $id failed ($p)"; fi; break ;;
      *) WHY="claim $p denied: $(printf %s "$CL" | head -1 | cut -c1-160)" ;; esac
  done
  [ "$OK" = 1 ] || sleep ${REGISTRY_RETRY_SLEEP:-3}
done
[ "$OK" = 1 ] || { echo "registry-install: round trip failed after $tries tries, last: $WHY" >&2; rollback; exit 1; }
echo "registry-install: installed$CHANGED (round trip ok, backups *.bak-$TS-pre-install)"
