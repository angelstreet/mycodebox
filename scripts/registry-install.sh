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
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
FILES="lease-service.js lease-routes.js catchup-supersede.js lease-equivalence.js scripts/lease-serve.js"
rssh() { ssh -o ControlPath=none -o ConnectTimeout=10 "$SSH_T" "$@"; }
CHANGED=""
for f in $FILES; do
  [ -f "$HERE/$f" ] || continue
  if rssh "cat ~/$DIR/$f" 2>/dev/null | cmp -s - "$HERE/$f"; then :; else CHANGED="$CHANGED $f"; fi
done
[ -z "$CHANGED" ] && { echo "registry-install: registry files already match the repo"; exit 0; }
echo "registry-install: changed:$CHANGED"
[ "$DRY" = 1 ] && exit 0
if vpt-lease deploy list 2>/dev/null | grep -q "state=running"; then echo "registry-install: a deploy is running; not installing now" >&2; exit 3; fi
TS=$(date -u +%Y%m%d-%H%M)
for f in $CHANGED; do
  case "$f" in *.js) ext=.js ;; esac
  tmp=/tmp/registry-install.$$.js
  rssh "cat > $tmp" < "$HERE/$f" || exit 1
  rssh "node --check $tmp" || { echo "registry-install: syntax check failed for $f" >&2; rssh "rm -f $tmp"; exit 1; }
  rssh "cd ~/$DIR && cp -p $f $f.bak-$TS-pre-install && cp $tmp $f && rm -f $tmp" || exit 1
done
rollback() { for f in $CHANGED; do rssh "cd ~/$DIR && cp -p $f.bak-$TS-pre-install $f"; done; restart; echo "registry-install: rolled back (backups *.bak-$TS-pre-install)" >&2; }
restart() {
  rssh "pid=\$(pgrep -u \$(id -u) -f 'node scripts/lease-serve.js' | head -1); [ -n \"\$pid\" ] && kill \$pid; i=0; while [ \$i -lt 30 ] && kill -0 \$pid 2>/dev/null; do sleep 1; i=\$((i+1)); done; sh ~/bin/mycodebox-lease-serve.sh; sleep 4"
}
restart
OK=0
for p in $PROBES ${REGISTRY_PROBE:-}; do
  vpt-lease check "$ENVN" "$p" >/dev/null 2>&1 || continue
  id=$(vpt-lease claim "$ENVN" "$p" --agent codebox:registry-install --ttl 5 --purpose "registry install round trip" 2>/dev/null | head -1)
  case "$id" in [0-9a-f]*) vpt-lease release "$id" >/dev/null 2>&1 && OK=1; break ;; esac
done
[ "$OK" = 1 ] || { rollback; exit 1; }
echo "registry-install: installed$CHANGED (round trip ok, backups *.bak-$TS-pre-install)"
