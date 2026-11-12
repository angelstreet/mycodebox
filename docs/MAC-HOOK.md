# Mac Stop hook (sessions on other machines under the manager)

Round 9, item 1. 210 of 234 owner turns in the 2026-10-14 harness review were on the Mac, where nothing watched the
sessions. This hook posts the final message of every Claude Code turn on the Mac to the dashboard. The same manager that
watches the tmux sessions classifies it (stall rules, round 7/8/10 policy), answers what it may after its usual
countdown, and tells you about the rest. Nothing is installed by this repository: you install the hook yourself from this
page.

## What it does

1. Claude Code finishes a turn and runs the `Stop` hook with a small JSON on stdin (`session_id`, `transcript_path`,
   `cwd`, `stop_hook_active`).
2. `scripts/mac-stop-hook.sh` reads the last assistant message, adds machine, project (basename of the git toplevel of
   `cwd`) and session name, and `POST`s it to `/api/remote/v1/stops` with a bearer token.
3. The dashboard shows the session as a row `mac:<session name>` (no tmux: it works while the Mac is offline, the row
   just stops updating), journals the stop in `stalls.jsonl`, writes the round-trip ledger and pushes "needs you" as for
   any session.
4. The hook long-polls `GET /api/remote/v1/stops/<id>/answer?wait=<s>` for up to the countdown (default 45 s, hard cap
   120 s). If the manager answers, the hook prints `{"decision":"block","reason":"<answer>"}`: Claude Code continues the
   session with that text as its next instruction. If the manager escalates, you cancel the countdown, the wait runs out
   or anything fails, the hook exits 0 and the session stops exactly as it does today.

### Why the hook's own long-poll is the answer channel

Options were Remote Control, an answer file polled by the hook, or the reporter channel. A `Stop` hook may return
`decision: block` with a `reason`, which is the one documented way to make a stopped Claude Code session continue with new
text, needs nothing on the Mac besides the hook, and travels over the same authenticated connection the stop arrived on.
Remote Control cannot type into a stopped session from the server side, and an answer file needs a second poller. The
limit: an answer can only be delivered **while the hook waits**. Anything later (you answer on the dashboard after the
countdown, or a stop that was escalated) goes through the Mac itself or Remote Control; the dashboard shows the Remote
Control link on the row when the hook sends `remote_control_url` (set `MYCODEBOX_RC_URL` in the environment Claude Code runs in).

Rules the server enforces on this channel:

- A stop that arrives with `stop_hook_active: true` (Claude is already continuing because of a hook) is journalled and
  escalated but never answered (loop guard).
- The manager's cap applies per session and hour (`maxPerSessionPerHour`, default 4).
- Cancelling the countdown on the dashboard resolves the long-poll with "no answer".
- Only the **deploy** topic is evaluated for a Mac session (it reads origin, and the runner deploys from origin; map the
  project to a local checkout in `<state>/remote.json`: `{"checkouts": {"<project>": "/path/on/the-dashboard-host"}}`).
  **Merge and push questions always escalate** with "evaluated only for local sessions: the Mac's branch is not visible
  here", checkout or not. Information answers, lease questions, `continue` and `menu_recommended` work as for local sessions.
- The countdown is the manager's `delayMs`, cut to the hook's deadline minus a 5 s margin, counted from when the decision is
  ready (`waitS` in `<state>/remote.json`, default 45, 1..120). No time left means the owner gets the stop at once.
- An answer is delivered only to a hook that is polling. If the hook stopped waiting (its poll closed, it did not come back
  within a few seconds, the deadline passed, or the answer found nobody), the pending answer is dropped and the stop is
  escalated to the owner with "the Mac hook stopped waiting before the answer". It is never marked answered.
- Each hook call is tied to its stop by the manager's stop id, so overlapping stops of one session cannot answer each other.
- The row is named `mac:<title>-<id6>` (title plus a fragment of the session id), so two sessions with one title stay apart.
  Machine, project and title are slugged by the server ("[TASK72] fix" becomes `TASK72-fix`), never rejected.

## Prerequisites

- macOS with `sh`, `curl` (7.55 or newer, for `-H @file`), `awk`, `sed`, `git`: all present by default. No python, no jq.
- The dashboard reachable from the Mac over Tailscale (see [INSTALL](INSTALL.md)). The route is tailnet and loopback
  only (`LEASE_ALLOW_CIDRS` adds ranges), authenticated by a token, and is never to be exposed publicly.
- Claude Code with hooks enabled.

## Install (on the dashboard host, then on the Mac)

On the dashboard host, create a token for a client that may post stops (printed once, only its hash is stored):

```sh
node scripts/lease-token.js add mac-<name> --remote
```

On the Mac:

```sh
mkdir -p ~/.config/mycodebox ~/bin
cp scripts/mac-stop-hook.sh ~/bin/mycodebox-stop-hook.sh && chmod +x ~/bin/mycodebox-stop-hook.sh
printf 'url = http://<tailscale-ip>:<port>\nwait = 45\n' > ~/.config/mycodebox/config
umask 077 && printf '%s' '<the token>' > ~/.config/mycodebox/token
```

The token file must be mode 600 or the hook sends nothing. Then add the hook to `~/.claude/settings.json`; the `timeout`
must exceed `wait` plus a few seconds:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "$HOME/bin/mycodebox-stop-hook.sh", "timeout": 130 } ] }
    ]
  }
}
```

## Verify

```sh
echo '{"session_id":"abc123456","transcript_path":"/path/to/a/session.jsonl","cwd":"'"$PWD"'"}' | ~/bin/mycodebox-stop-hook.sh --dry-run
```

`--dry-run` prints the payload that would be sent (and says where it would go) and sends nothing. Real transcripts live
under `~/.claude/projects/`. Then finish a turn in a Claude Code session: a row `mac:<session>` appears on the dashboard.

## Mac / cloud sessions: `integrate` and `found-bug`

Both are POSIX `sh` + `curl` scripts that read the same `~/.config/mycodebox/config` (`url = ...`) and `token` (mode 600) as the
hook; the token is a client added on the dashboard host with `node scripts/lease-token.js add mac-<name> --remote --integrate`.
**Update (owner, 2026-11-11): `integrate self-update`.** It fetches the current `scripts/integrate` and `scripts/found-bug` from the
dashboard host (`GET /api/integration/client-scripts[/<name>]`, same bearer token, integrate clients only), checks their sha256,
installs them atomically into `~/.local/bin` (`$MYCODEBOX_BIN_DIR` overrides) and keeps the old copy as `<name>.bak`; run again it
says "current". `found-bug --self-update` does the same. `integrate request` and `found-bug` print one line ("client scripts are
old: run integrate self-update") when the server's `CLIENT_SCRIPTS_VERSION` is newer, and `integrate request` prints a hint when
`found-bug` is not installed. Never blocking. Any session on the Mac can run it; nobody has to copy files by hand again.

**First install** (once, from a checkout that has this change, e.g. a fresh `git pull` of main; later updates need no checkout):

```sh
mkdir -p ~/.local/bin && cp scripts/integrate ~/.local/bin/ && chmod +x ~/.local/bin/integrate && integrate self-update
found-bug --help          # the one-line check
```

A bump rule for authors: change `scripts/integrate` or `scripts/found-bug` => raise `CLIENT_SCRIPTS_VERSION` in **both** (the test
keeps them equal), so every client warns until it has updated.

`found-bug --title T --why-not-fixed <large|other-area|host-or-device|credentials|owner-floor|live-session-task> --reason "one line" [--error "exact text"] [--repro R] [--blocking yes|no]` posts to `POST /api/bugs` over the tailnet with the
bearer token (since `CLIENT_SCRIPTS_VERSION=2` (owner, 2026-11-11) `--why-not-fixed` + `--reason` are required: without them the tool exits 2 with "Fix it yourself now (small + you have the repro)..."; an old copy that sends neither is still accepted and the record is stored with `why:"missing"`; run `found-bug --self-update`) (a remote client may only file and list: `--resolve`, `fixed` and `remove` are codebox-only). `GHOSTY_URL` overrides the
URL (default: `url` in the config, else loopback `http://127.0.0.1:7777`). Without a `--session` / tmux session the report is named
`mac-<client name>`. If the manager is unreachable the record is appended to `<state>/found-bug-queue.jsonl`
(`GHOSTY_STATE_DIR`, default `~/.local/state/ghosty`), the exit code is 5, and the next `found-bug` call or `found-bug --flush` posts
it: a report is never lost. When the script is not installed, file the same JSON by hand and say so in the report:

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat ~/.config/mycodebox/token)" -H 'content-type: application/json' \
  -d '{"title":"...","why":"other-area","reason":"...","error":"exact text","repro":"...","blocking":"no","session":"mac-<label>"}' "$GHOSTY_URL/api/bugs"
```

## Ship rule for Mac sessions (owner, 2026-11-11)

A small model (Haiku) on the Mac ended a fix with "Nothing is committed. If you want, I can open the dialog ... then commit."
and never typechecked, committed or ran `integrate request`: Claude Code's built-in default is "commit only when asked", and a
rule deep in a long file loses to it. The repo's `AGENTS.md` now opens with a ship rule; also put this block at the **very top**
of `~/.claude/CLAUDE.md` on the Mac so every project sees it in the first lines:

```
After a change: run the touched tests/typecheck yourself, commit, push your branch, `integrate request <branch> [--deploy ...]`.
Never ask permission for these and never end a turn with an offer ("I can ...", "if you want", "should I") for something the
rules already authorise. Verify UI yourself with headless Playwright (skill vpt-headless-verify). End with a STATUS line.
A bug you find: fix it now yourself, in its own worktree, when it is small and you have the repro (it does not have to be your task); file it only when it is large, needs another host/device/credentials, is an owner-floor item, or belongs to a live session's task; never end a turn with "I filed X so someone will fix it".
**The seven STATUS words (owner 2026-11-11). Take the first row that is true.**

| # | Word | Use it when | Never when | Who acts next |
|---|---|---|---|---|
| 1 | `done` | The goal is reached, you have the proof, nothing of yours is still running | A part is open, a worker or job of yours still runs, or it is "merged, not checked" | Nobody |
| 2 | `running` | Work **of yours** is still going: your background job, a worker session you started. You will be woken and continue | Nothing is actually running | Nobody; the harness wakes you |
| 3 | `waiting` | You depend on something **not yours** that ends by itself: a lane request, a deploy, a lease ticket, another session's work, a named time | You could work on something else meanwhile, or nothing will ever end it | Nobody; the harness wakes you |
| 4 | `needs-manager` | You need a decision or an answer (technical, merge, deploy, lease, design) | You have a recommendation and the choice is reversible: decide | Manager |
| 5 | `needs-owner` | Money, customers, deleting shared data, a credential only the owner holds, a physical action | Anything else | Owner |
| 6 | `blocked` | You **cannot work** and nothing running will fix it: someone must act (a device is dead, an access is missing) | Something is running or queued (that is `running` or `waiting`) | Manager |
| 7 | `failed` | You stopped and the goal is **not** reached after you tried what you could | You have not tried, or work is still running | Manager |

Forms: `done — <what> · goal: achieved · evidence: <links / run ids / frames>`; `running: <job id / worker names> — <what is left>`; `waiting: <id / ticket / session / time>`; `blocked: <what stops you> · tried: <list> · need: <who must do what>`; `failed — goal not achieved: <why> · tried: <list>`. "blocked: waiting on ..." is never right. A green / pass / proven claim carries its evidence.

Before you fix a filed bug, run `found-bug --claim <id>` (exit 3: someone else is fixing it).

**Goal first, verification last (owner 2026-11-11).** A task opens and closes with the same list.

- **First**: before any work, the task has `Goal: <one sentence>` and `Done when:` with 1 to 5 numbered lines, each checkable by something other than you: a fact the harness holds (merged, deployed, bug resolved), a command or URL with a pass / fail result, or an observation with an artefact (run id, report link, frame). The brief did not give them: write them yourself as the first thing you say, then work. A line you cannot check is rewritten, not dropped.
- **Time box** (owner 2026-11-11): the opening also carries `Time box: <max duration>` (the brief's, else your own estimate; default 2 h for a fix, 6 h for a feature). At 50% with no `Done when` line passed, say so and change approach. At 100% **stop**: write the `Verification:` block as it stands and end `failed` (or `needs-manager` with what would unblock it); never extend your own time box, the manager or the owner does. The same check failing 3 times with the same error is the same stop, whatever the clock says: a retry loop is not progress.
- **Last**: the final message ends with `Verification:` and one row per `Done when` line, in the same order and numbering: `<n>. pass | fail | not checked — <evidence that resolves, or why>`, then the STATUS line. All `pass` = `done`. Any `fail` or `not checked` = not `done` (`running`, `waiting` or `failed`). Never change the `Done when` list at the end to fit what you did; a line the owner dropped is marked "dropped by owner", not deleted.
- **Failing is not an ending** (owner 2026-11-12): before a `failed` line, investigate until you can name what broke (logs, frames, ledgers, code), or say what you checked and ruled out, and write the next approach. The line carries both: `STATUS: failed — goal not achieved: <why> · tried: <list> · cause: <what the investigation found> · plan: <next approach, who does it>`. A plan that is yours to do inside your time box is done, not written. A `failed` line without `cause:` and `plan:` is sent back once.
- **Done is about the task's goal, not the last request** (owner 2026-11-12): the `Goal` and the `Done when` list are the ones the task opened with. A side request given on the way (pause these deployments, check this, answer that) is reported in one sentence, and the turn ends on the task's true state: `running`, `waiting` or `needs-...` while a `Done when` line is open, never `done — goal: achieved (<the side request>)`. Only the owner or the manager replaces the goal, in words.
- **Done only with nothing open** (owner 2026-11-12): `done` needs `leftovers none` and `unverified none` in its closing review. A filed bug is not a finished task and an unverified item is a check not made: finish it, verify it, or end on the word that is true (`running`, `waiting`, `needs-manager`, `blocked`, `failed` with cause and plan). A bug outside the task goes in `bugs: reported <id>` and does not hold the line. A `done` line with anything open is sent back.
```

The done-check's git checks do not see Mac sessions (they read tmux panes and checkouts), so this block is the main guard there; the Stop
hook cannot answer such a stop because merge and push questions always escalate for a Mac session. The **goal check** does run on Mac stops
(owner 2026-11-11, [REFERENCE](REFERENCE.md#goal-check-owner-2026-11-11)): the hook sends the session's first prompt as `first_prompt` (the
goal), and a done stop is answered at once with "Goal as given: ... Did you reach it? Quote the evidence for each part", or sent back when it
lists 2+ filed leftovers. The reply comes back under the loop guard (`stop_hook_active`): it is judged but never answered, and a rejected one is
a manager event. Copy the hook again (`cp scripts/mac-stop-hook.sh ~/bin/mycodebox-stop-hook.sh`) to send `first_prompt`; an older hook works,
the question then asks the session to state its goal itself.

## Guard hook (proposed for the Mac, not installed)

The codebox PreToolUse guard (`scripts/session-guard-hook.js`: raw SQL writes, unchecked or lease-less vpt-* restarts, host-config saves
without `devices`; [REFERENCE](REFERENCE.md#session-guard-hook-owner-2026-11-11)) needs node and, for the restart rule, `vpt-lease` on PATH. On
a Mac with a mycodebox checkout the owner can add it with `node scripts/install-guard-hooks.js --checkout <path of that checkout>`; nothing
installs it remotely.

## VirtualPyTest agent name (X-Agent-Name, bug-c6a65805)

The host lease guard refuses an agent that drives a device another agent holds a vpt-lease on. It knows who drives from the header
`X-Agent-Name` of the `virtualpytest` MCP entry: `${VPT_AGENT_NAME:-}`, expanded by Claude Code from the session's environment.
- **Codebox:** `cbsession` exports `VPT_AGENT_NAME=<host>:<session>` (`codebox:<session>`, the name the agent claims leases under) in every
  launch file and runs `node scripts/vpt-mcp-agent-header.js --apply` once before a Claude start (a no-op when every project already has the header).
- **Mac:** run `node scripts/vpt-mcp-agent-header.js --apply` once on the Mac (it edits the `virtualpytest` entry of each project through
  `claude mcp`, never by hand in `~/.claude.json`; the Authorization value is kept and never printed). A session started from a shell
  then needs `export VPT_AGENT_NAME=mac:<session>` first; the desktop app has no per-session environment, so its calls arrive
  with an empty name (counted and logged by the host, never refused). `node scripts/vpt-mcp-agent-header.js` alone only lists the projects without it.
- A session started before the header is the norm sends no name: the host counts those calls per hour and never blocks them
  (`docs/LEASE-RULES.md`, "MCP calls without a name", in the virtualpytest repo).

## Disable

Any one of: `touch ~/.config/mycodebox/disabled`, `export MYCODEBOX_HOOK=off`, delete the `hooks.Stop` entry, revoke
the token on the host (`node scripts/lease-token.js revoke mac-<name>`). Switching the manager off for one session on the
dashboard also stops answers for it.

## Fields the hook reads (and what it tests against)

The transcript is JSONL. The final message is the last line with `"type":"assistant"` that holds
`{"type":"text","text":"..."}` blocks (`message.content[].text`); newer Claude Code versions also pass
`last_assistant_message` in the hook JSON, which wins because the transcript can lag the hook. The time of your last
real prompt is the `timestamp` of the last `"type":"user"` line whose `content` is a string (not a `tool_result` list);
the manager uses it as the moment you answered the previous stop (the round-trip ledger). The first prompt (`first_prompt`) is the `content` string of the
first such line, cut to 2000 characters. The session name is the last
`customTitle` (set by `/rename`), else `<project>-<first 6 of session_id>`. The text stays JSON-escaped end to end, and
only its last 12000 characters are sent. `test/fixtures/mac-transcript.jsonl` and `test/mac-hook.test.js` pin all of this.

## Privacy

Only the final message text, the first prompt of the session (2000 characters, the goal for the goal check) and these metadata leave the Mac: machine name, project, session id and name, working
directory, timestamps and the loop-guard flag. No transcript upload, no tool output, no file contents. The dashboard keeps
the excerpt in its stall journal like for local sessions (state dir, never committed). The token is read from a 0600 file
and passed to curl through a 0600 header file, never on a command line.

## Failure behaviour

The hook never blocks a session on its own failure: a missing or world-readable token, a missing URL or transcript, a
dead server, a slow server, an unexpected answer or any script error all end in exit 0. It is silent unless `--dry-run`.

## Done honesty and hook version (harness-done-honest, 2026-11-11)

The hook sends `hook_sha` (sha256 of itself) with every stop; the daily `installed-copies-check` reports a machine seen in the last 14 days whose hook
differs from `scripts/mac-stop-hook.sh` (copy it again). `first_prompt` is the first user line that is a string or a content list with a text block,
never an injected `<task-notification>` / `<system-reminder>` block. A done stop whose line says the work is not done, or lacks `goal: achieved` +
`evidence:`, is answered at once through the hook (once per line; a loop-guarded stop is never answered).
