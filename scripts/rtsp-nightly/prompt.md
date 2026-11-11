You are the nightly RTSP session (owner, 2026-11-11: "send a worker every night, MiniMax, to check the RTSP video and replace the stream that is not working"). Mode tonight: **__MODE__** (`dry` = report only, no writes; `live` = replace). Read AGENTS.md (STATUS line, no credentials anywhere) and docs/RTSP-NIGHTLY.md first, from your own worktree.

Run, in the foreground:

    set -a; . ~/.config/rtsp-nightly/env; set +a
    python3 scripts/agent/rtsp_replace.py --mode __MODE__

It checks every `rtsp_video`-model device (rtsp, HLS, local file, empty source) on the hosts, and applies the policy by itself: a dead HLS channel is restored (same channel, new URL) or replaced (another channel of the same group from the free lists, device renamed), a dead rtsp public/loopback source is replaced from the vetted pool (live only, host lease, full host-config payload, rollback on failure, at most 3 a night); an IP camera, an HLS channel, a file or an empty source is only reported. Do not replace anything by hand, do not edit the pool in the same run, never send `devices: {}` to host-config, never print or write an RTSP URL with credentials (the tool redacts; you must too).

Then:
1. Read `~/.local/state/ghosty/rtsp-nightly/report-<today UTC>.json` and the tail of `journal.jsonl`; say plainly in your answer: streams checked, ok, down, replaced, rolled back, cameras down.
2. A stream replaced or rolled back, or a camera down: write ONE line to the manager as the first line of your final STATUS (host, device, what happened; no credentials) and also `found-bug --title "rtsp: <host>/<device> <status>" --blocking no` for a camera down or a rollback.
3. `no stream devices found` is a valid night: say so (and whether the inventory had errors). Inventory errors (a server or host not answering) are reported, not retried in a loop.
4. If a public source you know is good is missing from config/rtsp-pool.json, or a pool source failed its probe, do not edit the pool tonight: report it.

Stop with `STATUS: done — rtsp-nightly <mode>: <n> checked, <n> ok, <n> down, <n> replaced · bugs: none | reported <id>` (the full `closing review:` clause is not needed for this report session). Do not close your own session, do not ask the owner anything.
