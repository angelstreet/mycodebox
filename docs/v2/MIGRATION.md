# Upgrading to V2: migration notes

[Documentation index](../README.md) · [Install guide](../INSTALL.md) · [V2 roadmap in the README](../../README.md#current-capabilities--v2-roadmap)

These notes are for an existing install. They describe source behavior, not the state of any running service: check your
own unit and environment before upgrading. No step here edits live settings, restarts the service or deletes state for
you. Restart only with `scripts/safe-restart.sh`, and only after confirming that the API it checks answers (see
[INSTALL](../INSTALL.md#update-and-uninstall)).

## What changes on upgrade

| Area | Before | After | What you do |
|---|---|---|---|
| Listener | `HOST` defaulted to all interfaces | `HOST` defaults to `127.0.0.1` | A service that **sets `HOST` explicitly** (for example a Tailscale IP) keeps working unchanged: the explicit value wins and only a warning naming the setting is printed. A service that relied on the old default is now loopback only, and phones lose access until you set `HOST` or use Tailscale Serve. Look for `HOST` in your unit's `Environment=` lines and its `EnvironmentFile` before restarting. If the unit sets no `HOST`, setting it is an owner action. |
| Agent launch commands | Defaults bypassed the CLI permission checks | `AGENT_CMD_CLAUDE=claude`, `AGENT_CMD_CODEX=codex` (normal permission prompts) | Existing explicit overrides are kept verbatim, including any bypass flag: remove obsolete flags yourself. Warnings name the setting, never its value. Already-running sessions are not changed. |
| Folder trust | Create and resume pre-accepted folder trust | No trust is written | Answer the CLI's trust and permission prompts in the session yourself. |
| Resume | Saved process flags were replayed | Resume rebuilds flags from model and remote-control metadata; saved permission flags are never restored | Nothing; a malformed saved conversation id is refused. |
| Manager restart (`scripts/manager-fresh.sh`) | Hard-coded CLI path | Uses `AGENT_CMD_CLAUDE`; prepends `$HOME/.local/bin` to `PATH`; refuses to type into tmux if the command cannot run | Make sure the Claude command is on the service or timer `PATH`, or configure an absolute path. The script does not load `.env` by itself: the unit's `EnvironmentFile` must. |
| Prices | `PLACEHOLDER` rows read as $0 | A `PLACEHOLDER` or missing price is **unknown** (`null`), shown as unknown and never routed on | Fill real prices in `usage/prices.json` when you have them. Until then V2 shows cost as unknown, not 0. |
| V2 task engine | n/a | Opt-in with `GHOSTY_V2=1`; off by default | Nothing, unless you want it. Off means no routes (404), no store, no timers. |

## The V2 state directory

V2 keeps its data in `$GHOSTY_STATE_DIR/v2` (default `~/.local/state/ghosty/v2`), separate from every V1 file
(`manager.json`, `layout.json`, logs, tokens, keys). Nothing in V1 reads it. It is created only when `GHOSTY_V2=1` and a
task is created or listed.

Layout: `index.json` and, per task, `tasks/<id>/events.jsonl` (the source of truth) with a derived `snapshot.json`. The
logs are append-only JSON lines. A torn last line from a crash is dropped on the next start, and a task whose log is
corrupt before the tail reads as `unknown` and refuses writes instead of guessing.

## Turning V2 on, trying it, and turning it off

1. Try it on a copy first: start a second instance with a throwaway `GHOSTY_STATE_DIR="$(mktemp -d)"` and `GHOSTY_V2=1`
   on another port. A second server still discovers your tmux sessions, so read the [agent contract](../CONTRACT.md) first.
2. To enable it on the real service, add `GHOSTY_V2=1` to the unit environment and restart through the guarded script.
   Creating a task through the UI or `POST /api/v2/tasks` only records it. The server does not start the goal loop;
   running tasks is a separate explicit step that this release's server does not take.
3. To disable it, remove `GHOSTY_V2` and restart. The routes disappear and the data stays on disk, untouched.

## Rollback

V2 is additive and reversible:

1. Revert the V2 commits (or check out the previous release) in an isolated checkout.
2. Delete `$GHOSTY_STATE_DIR/v2`. This removes only V2 tasks; V1 state is unaffected. Move it aside instead if you want
   to keep a copy of the task history.
3. Restart with the guarded script.

If you only want to stop using V2, unsetting `GHOSTY_V2` is enough (see above). A rollback of V2 alone does **not**
restore the old listener and launch behavior: the loopback default and the non-bypass launch defaults come from the
earlier security change. Revert that separately, and only if you accept running the old, less safe defaults.

## Checks after upgrading

- Request the health endpoint at the listener you configured and confirm phones still reach it.
- Open a session card: the CLI shows its own trust and permission prompts.
- With V2 off, `GET /api/v2/tasks` answers 404. With `GHOSTY_V2=1` it answers `{ ok:true, tasks:[...] }`.
- `node scripts/v2-score.js --store "$GHOSTY_STATE_DIR/v2"` reads the store without modifying it.
