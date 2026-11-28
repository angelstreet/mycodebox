#!/usr/bin/env bash
# Print the LAST line of the manager handover log (what the kickoff in manager-fresh.sh tells the fresh manager to read),
# as ONE log line for the restart log, so a restart can be confirmed from the log alone (token audit 2026-11-28).
#   manager-handover-line.sh            -> "manager handover line (<file>): <text, 400 chars max>"  |  "... : none (<why>)"
# HANDOVER_LOG overrides the path. Always exits 0: a missing log never stops a restart.
f="${HANDOVER_LOG:-$HOME/vpt-manager/docs/manager-handover.log}"
if [ ! -f "$f" ]; then echo "manager handover line ($f): none (no such file)"; exit 0; fi
line=$(grep -v '^[[:space:]]*$' "$f" 2>/dev/null | tail -n 1 | tr '\t\r' '  ' | cut -c1-400)
if [ -z "$line" ]; then echo "manager handover line ($f): none (file is empty)"; else echo "manager handover line ($f): $line"; fi
exit 0
