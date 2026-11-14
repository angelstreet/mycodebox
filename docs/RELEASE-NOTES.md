# mycodebox release notes

The release note of this repo (owner 2026-11-13). Every merged code change (not docs-only) adds one entry at the top of
`## Unreleased`; the done-check reads the merged diff for this file (REFERENCE "Closing review"). Entry form: one line,
what changed and why it matters, ending with `· area: <area>`.

## Unreleased

- **A live channel is judged over a window, not on its first frame** (bug-5ab9d8b4) — the nightly read the FIRST frame of a channel to decide whether the channel itself was black, but a channel can open on a dark frame: the Pluto TV channel of `vpt-nipogi/DEVICE7` starts its ad break on a frame of 17/255 and was called "the channel's own picture is black" while the channel itself played (the browser shows a movie frame, and the brightest frame of a 3 s window reads 103-119). The source is now judged over a window of frames (2 a second, 6 s, sampled again 10 s later if the window is dark), so an ad break no longer reads as a dead channel — and a channel that is really black stays black: `vpt-nipogi/DEVICE31` reads 16 over every window (1, 3, 6, 12 and 30 s). In plain words: a dark first frame no longer gets a healthy channel replaced · area: rtsp-nightly
- **Docs-only work ships in about 30 s, with a 30 min box** — the lane ends a docs-only merge right after the push (no CI wait, no deploy even with `--deploy`; mycodebox pulls live without a restart), and `cbsession` gives a docs task a 30 min box and a "no lease, no deploy" line: int-1a1d97e6aef011feb spent 27 s merging and 3 min 44 s in a host deploy, under a 2 h box · area: integration-lane
- **The unanswered-stop reminder reaches the Claude manager** — it was typed to the first entry of `managerSessions`, the MiniMax standby `mm-manager` (26 reminders on 2026-11-13 never reached the manager); it now goes to the first manager session that is not the failover standby, and stops sent to the wrong session are reminded once to the right one · area: manager-wakes
- **An idle session or Mac no longer keeps a lease, and a waiting stop is answered at once** — a codebox session at its prompt for 10 min with no background job loses its exclusive lease (`idle-release`, note to the session), a Mac holder with no renewal for 20 min and a waiter loses it too (nudge at 10 min, nothing while a run is attached), and a stop on a named-device wait while an equivalent is free gets the claim command within seconds; the 2026-11-11 replay shows 0 wrong releases and the first real releases ran on 2026-11-13: devices held by sessions that were only sitting there (9 idle nudges, 10 waits beside a free equivalent on 2026-11-11) · area: leases
- **New sessions do the work themselves: no workers unless the brief says so** — every `cbsession` prompt now carries the rule, a session started without `-K` cannot start another one (`cbsession` refuses, exit 2; the manager, the dashboard and `-A` automation are exempt), and AGENTS.md states it: sessions waited hours on idle workers for easy tasks · area: sessions
- **A request with nothing new is stopped at the prompt and named as such** — `integrate request` (client scripts v4) refuses a branch with commits origin does not have, or one that is not on origin, before it is queued (`--no-push-check` skips it), and a lane result for a branch already on the target now reads "nothing new: … no commit of yours was merged" instead of "merged <branch> at <another branch's sha>": two such requests deployed nothing and misled a session for ~14 min on 2026-11-13 ([review](reviews/2026-11-13-stb3-variant-hour.md)) · area: integration-lane
- **A stop the manager left unanswered is sent back to it once, and blocking bugs reach it only when the drain cannot start them** — a session stop with no message and no decision line after 10 min is typed to the manager (`stop-answer.js`); chained `manager-wait.sh` wakes are named as wait wakes, not own jobs; a blocking bug filing goes to the bug drain first and wakes the manager only as `bug-drain-cannot`: fewer wakes that do nothing (S7) · area: manager-wakes
- **A refused lease and a failed apply step are no longer the same thing** — the nightly report and the journal tell them apart
  (`lease_not_granted` / `apply_failed`): a claim the lease CLI refused touched nothing and is retried at the end of the night, while
  an apply step that died after the lease was granted is reported as such (the host may be half-changed), so the reader and the retry
  no longer go after the wrong cause · area: rtsp-nightly
- **A busy host lease no longer costs the night a stream** — the first lease wait is short (5 min) and a repair the lease blocked is
  retried at the end of the night with the long wait (20 min), reusing the source that was already probed: the nightly no longer
  gives up on a host another session is holding · area: rtsp-nightly
- **A film that opens on a black leader is not a dead stream** — the probe looks past the leader before it calls a picture frozen,
  and the nightly deletes its scratch file after the apply step: a healthy movie is no longer reported as broken, and the state dir
  no longer fills up night after night · area: rtsp-nightly
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
