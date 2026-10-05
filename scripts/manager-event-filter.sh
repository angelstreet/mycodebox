#!/bin/bash
# manager event filter (owner-approved 2026-10-04), reads manager-events.jsonl lines on STDIN (manager-wait.sh feeds it from the cursor):
# drops routine deploy start/done, events Jev says "ignore" at >= 0.9
# (never for asks/waiting/hold/quota/disk/credits or failed/orphan deploys), and repeats of the same stop (per run).
jq -c --unbuffered '
  select(
    ((.kind=="deploy") and (.state=="start" or .state=="done") and ((.blockedBy//[])|length)==0) | not
  ) | select(
    ((.jev.pick=="ignore") and ((.jev.confidence//0) >= 0.9) and (.kind=="deploy") and (.state!="failed") and (.state!="orphan")) | not
  ) | {k:((.session//"")+"|"+.kind+"|"+((.body//"")|gsub("\\s";"")|.[0:140])), l:.}' \
  | awk -W interactive '{ match($0,/^\{"k":"[^"]*"/); k=substr($0,RSTART,RLENGTH); if(!(k in s)){s[k]=1; print $0} }'
