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

## Disable

Any one of: `touch ~/.config/mycodebox/disabled`, `export MYCODEBOX_HOOK=off`, delete the `hooks.Stop` entry, revoke
the token on the host (`node scripts/lease-token.js revoke mac-<name>`). Switching the manager off for one session on the
dashboard also stops answers for it.

## Fields the hook reads (and what it tests against)

The transcript is JSONL. The final message is the last line with `"type":"assistant"` that holds
`{"type":"text","text":"..."}` blocks (`message.content[].text`); newer Claude Code versions also pass
`last_assistant_message` in the hook JSON, which wins because the transcript can lag the hook. The time of your last
real prompt is the `timestamp` of the last `"type":"user"` line whose `content` is a string (not a `tool_result` list);
the manager uses it as the moment you answered the previous stop (the round-trip ledger). The session name is the last
`customTitle` (set by `/rename`), else `<project>-<first 6 of session_id>`. The text stays JSON-escaped end to end, and
only its last 12000 characters are sent. `test/fixtures/mac-transcript.jsonl` and `test/mac-hook.test.js` pin all of this.

## Privacy

Only the final message text and these metadata leave the Mac: machine name, project, session id and name, working
directory, timestamps and the loop-guard flag. No transcript upload, no tool output, no file contents. The dashboard keeps
the excerpt in its stall journal like for local sessions (state dir, never committed). The token is read from a 0600 file
and passed to curl through a 0600 header file, never on a command line.

## Failure behaviour

The hook never blocks a session on its own failure: a missing or world-readable token, a missing URL or transcript, a
dead server, a slow server, an unexpected answer or any script error all end in exit 0. It is silent unless `--dry-run`.
