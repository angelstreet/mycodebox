#!/usr/bin/env bash
# Keep a shared checkout current with origin/main without ever touching work in it (bug-bb3640f1).
# Fetch, then `merge --ff-only`, but ONLY when the checkout is on `main`, has no tracked change, no untracked file
# and no merge/rebase/cherry-pick in progress. Anything else is logged and skipped; nothing is stashed, reset or cleaned.
# Usage: checkout-sync.sh [checkout]      (default ~/virtualpytest; STATE log: $GHOSTY_STATE_DIR/checkout-sync.log)
# Exit 0 always (a timer must not turn red for a skip); the last line says synced|current|skipped: <why>.
set -uo pipefail
DIR="${1:-$HOME/virtualpytest}"
BRANCH="${CHECKOUT_SYNC_BRANCH:-main}"
LOG="${GHOSTY_STATE_DIR:-$HOME/.local/state/ghosty}/checkout-sync.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
say() { printf '%s %s: %s\n' "$(date -u +%FT%TZ)" "$DIR" "$*" | tee -a "$LOG"; }
g() { git -C "$DIR" "$@"; }
[ -d "$DIR/.git" ] || [ -f "$DIR/.git" ] || { say "skipped: not a git checkout"; exit 0; }
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=20}"
gd=$(g rev-parse --git-dir 2>/dev/null) || { say "skipped: git failed"; exit 0; }
case "$gd" in /*) ;; *) gd="$DIR/$gd" ;; esac
cur=$(g symbolic-ref --short -q HEAD || echo "(detached)")
[ "$cur" = "$BRANCH" ] || { say "skipped: on '$cur', not $BRANCH"; exit 0; }
for f in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply index.lock; do
  [ -e "$gd/$f" ] && { say "skipped: $f present (operation in progress)"; exit 0; }
done
[ -z "$(g status --porcelain 2>/dev/null)" ] || { say "skipped: working tree is not clean"; exit 0; }
g fetch --quiet origin "$BRANCH" 2>/dev/null || { say "skipped: fetch failed"; exit 0; }
behind=$(g rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)
[ "$behind" -gt 0 ] || { say "current"; exit 0; }
g merge-base --is-ancestor HEAD "origin/$BRANCH" || { say "skipped: local $BRANCH has commits not on origin (not fast-forward)"; exit 0; }
# re-check right before the merge: a session may have started editing during the fetch
[ -z "$(g status --porcelain 2>/dev/null)" ] || { say "skipped: working tree changed during the fetch"; exit 0; }
old=$(g rev-parse --short HEAD)
if g merge --ff-only --quiet "origin/$BRANCH" 2>/dev/null; then say "synced: $old -> $(g rev-parse --short HEAD) ($behind commits)"
else say "skipped: ff-only merge refused"; fi
exit 0
