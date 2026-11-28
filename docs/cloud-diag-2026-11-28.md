# Cloud diagnostics 2026-11-28

## Environment facts

```
$ id
uid=0(root) gid=0(root) groups=0(root)
$ node -v
v24.22.3
$ command -v ps setsid tmux pgrep pkill bash sh ffprobe ffmpeg curl python3
/usr/bin/ps
/usr/bin/setsid
/usr/bin/tmux
pgrep
pkill
/usr/bin/bash
/usr/bin/sh
/usr/bin/ffprobe
/usr/bin/ffmpeg
/usr/bin/curl
/usr/local/bin/python3
$ ps -o pid,pgid,sid,comm -p $$
  PID  PGID   SID COMMAND
  244   244   244 bash
$ cat /proc/1/comm
process_api
$ ulimit -a | head -5
real-time non-blocking time  (microseconds, -R) unlimited
core file size              (blocks, -c) 0
data seg size               (kbytes, -d) unlimited
scheduling priority                 (-e) 0
file size                   (blocks, -f) unlimited
$ ls -ld /tmp
drwxrwxrwt 7 root root 4096 Nov 28 16:20 /tmp
$ echo $TMPDIR
/tmp
$ uname -r
6.18.44-fc-v880
```

### cloud-setup.sh (tail)

```
npm notice
npm notice New major version of npm available! 10.9.9 -> 12.2.3
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.3
npm notice To update run: npm install -g npm@12.2.3
npm notice

added 1 package in 347ms
cloud-setup: mycodebox ready (node v24.22.3); run tests with: npm test
setup exit 0
```

## test/lease-wait-orphan.test.js

`node --test test/lease-wait-orphan.test.js 2>&1` (full output)

```
✔ a waiter whose parent shell died is cancelled, so it never claims after the holder releases (5895.432278ms)
✔ a live waiter whose agent releases everything (release --agent) is cancelled and never claims (2861.398622ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 30341.647156
exit 0
```

## test/minimax-fallback.test.js

`node --test test/minimax-fallback.test.js 2>&1` (full output)

```
✔ parseExecOutput: 0.6.3 and 0.6.5 shapes, failures (2.030826ms)
✔ parseChoice: only listed choices, probabilities normalised, confidence capped (1.465492ms)
[manager] on, auto-send ON (continue,menu_recommended), jev on, ai triage simulate, log /tmp/ghosty-fb-w15F3n/stalls.jsonl
✔ reviewer(): same prompt and parser, headless and sandboxed: smart permission, empty temp cwd, one step, 20 s, no secrets in the environment (170.644113ms)
✔ choice(): a Jev-shaped reply; an invalid choice, a failure and a hang are errors (the hang is killed at the timeout) (628.761621ms)
[fallback] mcode without lightweight mode: /tmp/fallback-j68ph0/no-such-mcode (the MiniMax fallback is off until mcode 0.6.5 or newer is installed)
✔ three failures in a row pause the fallback; a missing binary is an error, not a throw (115.984258ms)
✔ no OpenRouter credit: the AI triage is read by MiniMax (source minimax-fallback), nothing is sent to the primary, and it is journalled (180.169737ms)
✔ no OpenRouter credit: an ambiguous stop is decided by the fallback (Jev-style choice) instead of skipped (99.691573ms)
✔ aiFallback "off" restores the old behaviour: skipped, no mcode process (71.915275ms)
✔ the daily cap stops fallback calls (72.307868ms)
✔ credit is back: the primary is used again; a 402 found by the reviewer call itself still gets the stop read by the fallback (194.438987ms)
✔ a tool call anywhere in the output is an error, never an answer (91.55577ms)
✔ lightweight mode is required: probed once, passed on every run; an mcode without --mode (0.6.3) is refused and the refusal is logged once (144.438576ms)
✔ MCODE_NODE_DIR's mcode is preferred when it supports lightweight mode; the PATH one is used when only it does (112.889527ms)
✔ one fallback process at a time: a second call is skipped as "fallback busy" (1302.459032ms)
✖ a timeout kills the whole process group, children included (833.322617ms)
[manager] on, auto-send off, jev on, ai triage simulate, log /tmp/ghosty-fb-w15F3n/stalls.jsonl
✔ merge / push / deploy evaluations never use the fallback: with Jev unavailable they keep the round-7 path (the manager's own reasoning) (212.143382ms)
ℹ tests 16
ℹ suites 0
ℹ pass 15
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4379.111816

✖ failing tests:

test at test/minimax-fallback.test.js:247:1
✖ a timeout kills the whole process group, children included (833.322617ms)
  AssertionError [ERR_ASSERTION]: pid 643 is gone
  
  true !== false
  
      at TestContext.<anonymous> (file:///home/user/mycodebox/test/minimax-fallback.test.js:254:34)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: true,
    expected: false,
    operator: 'strictEqual',
    diff: 'simple'
  }
exit 1
```

## test/mm-manager.test.js

`node --test test/mm-manager.test.js 2>&1` (full output)

```
✔ realAction: a non-owner send within 15 min -> answer (1.203375ms)
✔ realAction: an escalated record within 15 min -> escalate (0.137606ms)
✔ realAction: a manager-agent alert within 15 min -> alert (0.130872ms)
✔ realAction: only an owner send -> owner (0.152044ms)
✔ realAction: nothing within 15 min -> none (0.128704ms)
✔ realAction: mm-manager by is ignored (shadow never acts) (0.098239ms)
✔ hasForbiddenTopic: deploy in excerpt -> true (0.141353ms)
✔ hasForbiddenTopic: clean excerpt -> false (0.07251ms)
✔ hasForbiddenTopic: missing -> false (0.126087ms)
✔ classifyAgreement: real=answer, mm=answer -> agree (0.316148ms)
✔ classifyAgreement: real=owner, mm=none -> miss (0.222818ms)
✔ classifyAgreement: real=answer, mm=escalate -> miss (0.060129ms)
✔ classifyAgreement: mm=answer but forbidden topic -> needs a deny (0.095501ms)
✔ classifyAgreement: real=alert, mm=alert -> agree (0.040233ms)
✔ classifyAgreement: real=owner, mm=escalate -> agree (0.044764ms)
✔ auditCheck: no mm-manager by -> empty (0.620553ms)
✔ auditCheck: any by containing mm-manager -> hit (0.081886ms)
✔ sumBuckets: sums MiniMax tokens, sonnet $ from decisions, real-mgr $ from ledger (0.266421ms)
✔ buildReport: aggregates per day, sonnet $, real-mgr $, AUDIT on mm-manager by (0.708272ms)
✔ dayKey: extracts YYYY-MM-DD in UTC (0.060132ms)
✖ mm-manager.sh --once --dry writes a prompt with events + rules; tolerates a closed port (22.186025ms)
✔ realAction: owner-via-<session> send is the owner, not the real manager (0.105527ms)
✔ agent-alert naming the session counts as a real alert; one naming another does not (0.088166ms)
✖ mm-manager.sh --once with a fake mcode records proposals, mm_ms and tokens (no network) (18.488962ms)
✔ buildReport: batch token usage copied on each event of a batch is counted once (0.327438ms)
✔ formatReport: prints all five verdicts and lists extra / differs / miss / risky keys (0.648157ms)
ℹ tests 26
ℹ suites 0
ℹ pass 24
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 114.050696

✖ failing tests:

test at test/mm-manager.test.js:151:1
✖ mm-manager.sh --once --dry writes a prompt with events + rules; tolerates a closed port (22.186025ms)
  AssertionError [ERR_ASSERTION]: exactly one prompt file
  
  0 !== 1
  
      at TestContext.<anonymous> (file:///home/user/mycodebox/test/mm-manager.test.js:181:10)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test/mm-manager.test.js:206:1
✖ mm-manager.sh --once with a fake mcode records proposals, mm_ms and tokens (no network) (18.488962ms)
  Error: ENOENT: no such file or directory, open '/tmp/mmmgr-fake-pg7VFv/mm-manager-decisions.jsonl'
      at readFileSync (node:fs:483:20)
      at TestContext.<anonymous> (file:///home/user/mycodebox/test/mm-manager.test.js:216:26)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    errno: -2,
    code: 'ENOENT',
    syscall: 'open',
    path: '/tmp/mmmgr-fake-pg7VFv/mm-manager-decisions.jsonl'
  }
exit 1
```

### bash -x scripts/mm-manager.sh --help 2>&1 | head -40

```
+ set -u
+++ dirname scripts/mm-manager.sh
++ cd scripts
++ pwd
+ SCRIPT_DIR=/home/user/mycodebox/scripts
++ cd /home/user/mycodebox/scripts/..
++ pwd
+ REPO=/home/user/mycodebox
+ STATE_DIR=/root/.local/state/ghosty
+ GHOSTY_PORT=7777
+ BATCH_S=60
+ MM_RUNBOOK=/home/user/mycodebox/.manager-s4.md
+ MCODE=/root/.local/bin/mcode
+ NODE_BIN=/root/.local/node-v24.21.0-linux-x64/bin
+ MCODE_TIMEOUT=10m
+ MM_LOG=/root/.local/state/ghosty/mm-manager-decisions.jsonl
+ BATCH_DIR=/root/.local/state/ghosty/mm-manager
+ LOCK_DIR=/root/.local/state/ghosty/mm-manager.lock
+ mode=tail
+ once_file=
+ dry=0
+ alert=0
+ '[' 1 -gt 0 ']'
+ case "$1" in
+ sed -n '2,/^[^#]/p' scripts/mm-manager.sh
+ sed '/^$/d'
+ head -n 40
# mm-manager (TASK-47 G11, SHADOW only): a manager loop run by MiniMax that proposes what the manager should
# do for each event, calls Sonnet only when in doubt, and NEVER acts. Compares against the real (Sonnet)
# manager via scripts/mm-manager-compare.js.
#
# Usage:
#   scripts/mm-manager.sh                        tail <state>/manager-events.jsonl and process batches
#   scripts/mm-manager.sh --once <file>          process the lines of <file> once and exit (tests/dry runs)
#   scripts/mm-manager.sh --dry                  with --once: write the prompt only, no mcode call
#   scripts/mm-manager.sh --alert                ALERT-ONLY mode (owner Q36, 2026-10-06): escalate/alert proposals are
#                                                POSTed to /api/alert (the owner's ntfy). Still never sends to a
#                                                session, deploys or pushes. One alert per event key per 6 h.
#
# Env (sane defaults):
```

## test/owner-ask.test.js

`node --test test/owner-ask.test.js 2>&1` (full output)

```
✔ no floor -> refused, nothing written (61.671415ms)
✔ floor not in the list -> refused (46.032372ms)
✔ empty --what -> refused (40.443375ms)
✔ empty --why -> refused (41.039165ms)
✔ bare internal id in the question -> refused (38.31992ms)
✔ a recommended option that changes nothing -> refused (231.132445ms)
✔ a free-text recommendation is read as the option it points at (99.259123ms)
✔ a why that is a bare technical term list -> refused (44.807915ms)
✔ a why that does not name the floor risk -> refused (47.726608ms)
✔ a why of more than one line -> refused (41.474858ms)
✔ a why that names the risk in plain words -> accepted (38.902395ms)
✔ valid ask -> one ledger line with floor, what and why (51.282079ms)
✔ a second ask continues the numbering and appends (88.597749ms)
✔ decide -> a "Decided for you" entry with the why and the undo (42.253406ms)
✔ decide without --undo -> refused (37.341958ms)
✔ an unknown command -> refused (39.303452ms)
✔ help lists the floors (37.033887ms)
✔ the live state dir is only the fallback (0.771638ms)
[owner-asks] ledger damaged: 5 unusable line(s) at line 3,4,5,6,7, 4 record(s) lost - the file needs repair
✔ a damaged line does not hide the open asks around it (8.971107ms)
[owner-asks] ledger damaged: 1 unusable line(s) at line 1, 1 record(s) lost - the file needs repair
✔ a line holding two concatenated records recovers both, in order (3.826512ms)
✔ damaged lines are surfaced with a count and line numbers, not their content (11.758502ms)
✖ an unreadable ledger is reported, not mistaken for an empty one (2.951436ms)
✔ supersedeOlder writes one record per line and the file stays parseable (3.866916ms)
✔ concurrent writes leave a file where every line parses (14.965608ms)
✔ happy path: the newest open ask of a session stands, an ask that was never replaced stays visible (1.148316ms)
✔ a missing ledger returns no asks instead of throwing (0.763338ms)
ℹ tests 26
ℹ suites 0
ℹ pass 25
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1152.773386

✖ failing tests:

test at test/owner-ask.test.js:298:1
✖ an unreadable ledger is reported, not mistaken for an empty one (2.951436ms)
  AssertionError [ERR_ASSERTION]: nothing is readable
  + actual - expected
  
  + [
  +   {
  +     at: '2026-10-21T10:01:00.000Z',
  +     floor: 'money',
  +     id: 'Q1',
  +     options: [
  +       'first thing',
  +       'second thing'
  +     ],
  +     question: 'Synthetic question 1?',
  +     recommendation: '1',
  +     session: 'manager:s1',
  +     what: 'Synthetic what.',
  +     why: 'Synthetic why.'
  +   }
  + ]
  - []
  
      at TestContext.<anonymous> (file:///home/user/mycodebox/test/owner-ask.test.js:306:10)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [ { id: 'Q1', at: '2026-10-21T10:01:00.000Z', session: 'manager:s1', question: 'Synthetic question 1?', recommendation: '1', floor: 'money', what: 'Synthetic what.', why: 'Synthetic why.', options: [Array] } ],
    expected: [],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
exit 1
```

## test/rtsp-check.test.js

`node --test test/rtsp-check.test.js 2>&1` (full output)

```
✔ rtsp_check: ok, no_connect, no_video, frozen; exit code; credentials never printed (228.789461ms)
✔ rtsp_check: a loopback source without an ssh alias is unverified, never ok (68.238694ms)
✔ rtsp_check: a file that opens on a black leader is ok, not frozen (the probe looks past the leader) (228.685597ms)
✔ rtsp_check: --host probes a loopback source from that host (alias from RTSP_CHECK_SSH) (203.570649ms)
✔ run live: a dead public stream is replaced with the FULL devices payload; camera and healthy streams untouched (250.163418ms)
✔ run dry (the default): reports what it would do and writes nothing (127.508007ms)
✔ the report says how many hosts were walked, so an empty night is readable (178.1699ms)
✖ the summary separates the streams that are down from the devices without a source, and a YouTube device is not down (115.673103ms)
✔ run live: a BUSY lease never runs the command, nothing is touched (112.324294ms)
✔ run live: a lease busy for the short wait is retried at the end of the night, so the stream is repaired (210.979248ms)
✔ run live: an apply step that died after the lease was granted is not reported as a missing lease (165.31547ms)
✔ run live: an apply step that died without any result is not a refused lease either (117.46762ms)
✔ run live: a source that dies after it was installed is replaced again in the same night (308.805477ms)
✔ run live: a missing lease command is reported, the night does not die on it (190.471942ms)
✔ run live: a replacement that does not play is rolled back to the backup (full payload again) (197.297427ms)
✔ a dead HLS channel is restored (same channel, new URL) or replaced (same group, unused, renamed); file / empty only reported (536.249635ms)
✔ a renamed device shows its new title in the app once the host has reported it (bug-ee21b77c) (239.931483ms)
✔ a renamed device whose title the app still shows with the old name is reported, not hidden (bug-ee21b77c) (213.810957ms)
✔ the pool file never holds credentials and only vetted entries are replacement candidates (0.815947ms)
✔ a dark thumbnail whose live video cannot be read is not called black: the tile is not proven broken (bug-4f69009f) (121.517962ms)
✔ a slow host that loses the first live-layer measurement is measured again, not read as unreadable (bug-c27e2c95) (152.091747ms)
✔ the pool entries are probed in parallel, the night does not wait for every timeout in turn (bug-5473cd69) (1112.616664ms)
✔ the report carries the pool's own probe status, so a broken pool source is visible without a hand probe (idea bug-c64fb86c) (87.412981ms)
✔ a stream that fails once but plays on the slower re-probe, or shows a frozen picture, is never changed (108.041321ms)
✔ a 502 blip from the server is retried: the night still reads its hosts (102.944508ms)
✔ the tile snapshot is checked too: a black or stale host capture of a playing source is reported, never changed (154.665188ms)
✔ a black tile needs both layers dark: a dark thumbnail with a live tile that plays is not a broken tile (bug-6b227d92) (137.478018ms)
✔ a tile that was black at the check but plays on the re-read is a note, not a black tile (bug-9a0cd4c9) (140.720368ms)
✔ a file whose tile snapshot is black is measured against the clip itself and never blamed on the capture side (143.194811ms)
✔ a file tile says the clip own picture is dark only when it was measured (bug-59664715) (124.161616ms)
✔ a tile whose newest live segment is dark but whose recent segments play is not a host-capture fault (bug-37646a38) (105.815454ms)
✔ a channel whose own picture is black: reported while capture checks are dry, repaired from the lists once live (338.141103ms)
✔ a live channel is judged over a window: a dark first frame is not a black channel (the ad-break case) (125.216999ms)
✔ a host stream with several audio tracks (the browser player stays black) is reported (109.951829ms)
✔ --help runs nothing, an unknown flag is refused, and a dry run never overwrites the live report of the day (371.916371ms)
✔ the night reads the A/V offset of the host segment: a drifting channel is reported, never replaced (129.949831ms)
✔ a small A/V offset is mux jitter, not a fault: no report (142.00451ms)
✔ a dark snapshot with a live video is a note in its own field, not an action (owner 2026-11-27) (153.17574ms)
✔ the browser layer is off by default and the report says so (111.14578ms)
✔ the browser layer: a tile that does not play while the source plays is reported, never replaced (118.008646ms)
✔ the browser layer: a tile that plays on its own is not called broken (the sweep load reads tiles black) (118.428732ms)
✔ the browser layer: a file whose tile does not play is measured against the clip, never blamed on the capture side (124.966705ms)
✔ the browser layer: a sweep that read some tiles and could not finish says partial, not skipped (102.972267ms)
✔ the browser layer: a card with no live player (a drone, a PC screen) is not a broken tile (133.680748ms)
✔ the browser layer: a card with no live player never becomes a fault of a device (115.527426ms)
✔ the tile verdict: a live player that sits at readyState 1 while it plays is a playing tile (0.301889ms)
✔ the tile verdict: a live tile at the live edge that nudges its clock back is a playing tile (0.08131ms)
✔ the tile verdict: a black picture, a frozen clock, a failed request of its own and a card without a player (0.07146ms)
✔ the browser layer: the auto-sign token never leaves the sweep (Playwright quotes the URL it was given) (5043.153711ms)
✔ the browser layer: the report never keeps a token the sweep quoted (117.667822ms)
✔ the browser layer: the page load is retried once before the layer gives up (5042.78851ms)
✔ the inventory error says the HTTP status: a blip and a refusal are not the same (152.359193ms)
✔ the night asks the browser layer for the frame of a tile that plays (a dark snapshot with a live video) (138.854045ms)
✔ a pool entry the owner marked is not probed any more: the known failure stops repeating (112.575668ms)
✔ an empty slot gets a channel suggested from the free lists, and nothing is written (134.581162ms)
✔ the suggestion of an empty slot stays the one of the last night, as long as it plays (127.64942ms)
✔ the suggestion of an empty slot moves on when the kept channel stopped playing (129.375627ms)
✔ the report carries the A/V drift rate: the offset alone hides how fast it grows (103.122243ms)
✔ the report says what changed since the last night (126.988756ms)
ℹ tests 59
ℹ suites 0
ℹ pass 58
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 19715.4558

✖ failing tests:

test at test/rtsp-check.test.js:222:1
✖ the summary separates the streams that are down from the devices without a source, and a YouTube device is not down (115.673103ms)
  AssertionError [ERR_ASSERTION]: nothing is down and nothing errored: the night exits 0
  
  1 !== 0
  
      at TestContext.<anonymous> (file:///home/user/mycodebox/test/rtsp-check.test.js:234:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 1,
    expected: 0,
    operator: 'strictEqual',
    diff: 'simple'
  }
exit 1
```

## test/v2-ui-docs-verify.test.js

`node --test test/v2-ui-docs-verify.test.js 2>&1` (full output)

```
[v2] task task-c3-id0001: corrupt log: Expected property name or '}' in JSON at position 1 (line 1 column 2)
✔ XSS: every task-derived string in list and detail is escaped (no raw tag, no attribute breakout) (3.501092ms)
✔ ids: traversal and encoded separators are refused before the store; GET on an action path records nothing (15.11317ms)
✔ approval replay: an answered request id cannot be reused for the next request, and a new request needs its own id (26.168911ms)
✔ a corrupt task log reads as unknown in API and view, never done (27.114839ms)
✖ store_error exposed by GET does not leak absolute filesystem paths (6.604295ms)
✔ evidence for a reverted SHA (A -> B -> A) is not shown as passing on the current head (11.20958ms)
✔ partial usage (incomplete: true) is surfaced, not shown as complete totals (14.642958ms)
✔ D5: an accepted task without delivery is labelled verified in worktree, not integrated (17.011652ms)
✔ after the owner answered, next_action says the answer awaits the loop (not "request not readable" / "decision needed") (7.757039ms)
✔ waiting, needs owner and unknown never collapse; only outcome done gets the done badge (0.381765ms)
✔ server.js: V2 is gated on GHOSTY_V2 === "1", imports lazily, reaches the goal loop only through v2-runtime.js, adds no listener (2.708547ms)
✔ scoring math: even-count median, rate, cost per verified, unknown makes cost null (120.15361ms)
✔ scoring: incomplete usage records make the cost unknown (24.130873ms)
✔ scoring: spend on failed tasks counts toward cost per verified completion (46.793297ms)
✔ scoring: a head set by worktree revalidation (external:worktree) is not exported as a router model (15.443588ms)
✔ scoring: a torn tail appended after scoring started is tolerated and nothing is written (17.502072ms)
✔ XSS: queue, runs, roles, allowed actions, task graph and delivery are escaped (0.64755ms)
✔ delivery: "integrated" only when the accepted transition came out of release_verifying (18.961904ms)
✔ approval binds the SHA the request was raised on, even after the head moved (9.998372ms)
✔ a malformed policy snapshot does not crash the detail route into an internal error (5.054161ms)
ℹ tests 20
ℹ suites 0
ℹ pass 19
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 525.507116

✖ failing tests:

test at test/v2-ui-docs-verify.test.js:132:1
✖ store_error exposed by GET does not leak absolute filesystem paths (6.604295ms)
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
      at async TestContext.<anonymous> (file:///home/user/mycodebox/test/v2-ui-docs-verify.test.js:136:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: undefined,
    expected: undefined,
    operator: 'rejects',
    diff: 'simple'
  }
exit 1
```
