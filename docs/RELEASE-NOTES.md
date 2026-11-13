# mycodebox release notes

The release note of this repo (owner 2026-11-13). Every merged code change (not docs-only) adds one entry at the top of
`## Unreleased`; the done-check reads the merged diff for this file (REFERENCE "Closing review"). Entry form: one line,
what changed and why it matters, ending with `· area: <area>`.

## Unreleased

- **A night that finds nothing now says how much it looked at** — the nightly report carries `hosts` (`walked`: the hosts the
  servers listed, `read`: the hosts whose config answered), so "no rtsp devices found" can no longer be read as an empty inventory:
  15 hosts walked and 15 read is a fleet without an RTSP source, while 15 walked and 14 read is a host that did not answer ·
  area: rtsp-nightly
- **A loopback pool source can be vetted from the host that runs it, and a missing lease CLI no longer kills the night** —
  `rtsp_check.py --host <host>` (its ssh alias from `RTSP_CHECK_SSH`) and `--ssh <alias>` play a loopback source where the host
  plays it instead of always answering "unverified", and in live mode a `vpt-lease` that is not on the PATH is reported as "the
  lease command could not be run, nothing touched" and the night goes on instead of dying on the first down stream · area: rtsp-nightly
- **A black tile now needs both of its pictures dark** — the nightly reads the tile's thumbnail *and* the live video the browser
  plays (the newest HLS segment, the brightest picture it holds), so a dark moment of a moving clip is reported as a note instead of
  a dead stream, and a looping clip is never blamed on the capture side: the capture-driven repair now replaces a channel only when
  thumbnail, live video and source frame all agree · area: rtsp-nightly
- **The agent runtime's own process-group guard is no longer read as the session's job** — `own-jobs` treats an inline node module
  (`node --input-type=module --eval`) as the runtime's infrastructure, like the `node -e` helper next to it: a STATUS word that merely
  sits inside that command line ("live" in "keepalive", "table" in "system32") no longer pins a `done` line to `running` · area: harness
- **Done-check asks for the release note and the bug record after a code fix** — a `STATUS: done` line after a merged code integration (not docs-only) whose diff has no release-note entry and whose closing review gives no `release note none needed: <reason>`, or whose fix names no bug id in `bugs:`, is sent back once with the two asks. In plain words: a shipped fix leaves a release note and a bug record without the owner asking · area: harness
