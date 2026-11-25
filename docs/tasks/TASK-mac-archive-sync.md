# TASK mac-archive-sync (owner 2026-11-25)

Owner: "I see sessions when I create them on my Mac, but if I archive one on my Mac, can it also archive on codebox? Otherwise I have
to do it manually, and manually it fails."

Goal: archiving a session in the Claude app on the Mac parks the matching codebox session in ghosty automatically.

Done when: (1) investigation below; (2) a reliable signal parks / removes the matching row within 2 minutes, only on that action, with
tests that idle, done, vanished and usage limit never trigger it, release note + CONTRACT/REFERENCE line; (3) fallback only if no
signal; (4) both manual routes (Park on a `mac:` row, X on a Parked row) retested live with headless frames.

## Investigation (2026-11-25)

Two kinds of rows can be archived from the Claude app:

- **codebox sessions** (tmux, started with `--remote-control`): shown in the app as Remote Control sessions.
- **Mac sessions** (`mac:<title>-<6 chars of the local session id>` rows, created by the Mac Stop hook, `remote-stops.js`): they have no
  tmux pane; "Park" on such a row only removes it from the list (int-1a212872b54d71929).

Signals checked:

| Signal | What it shows | Reliable for archive? |
|---|---|---|
| Transcript line `Remote Control disconnected — this session was ended or archived from another device or app (code 4090)` + Claude clears `bridgeSessionId` in `~/.claude/sessions/<pid>.json` | 196 transcripts on codebox carry it. Already used by `autoParkArchived` (parking.js), which parked `irtrans-ble-review-20261124` and `pi1-streams-stuck-20261125` today | codebox only, and only when the CLI was connected at archive time (it cannot hear a 4090 while disconnected). Does not exist for Mac rows: the Mac hook only posts on Stop, and an archive is not a Stop |
| `ListAgents` (Remote Control peers) | Mac sessions as `Remote Control · idle / offline`; archived ones simply disappear | no: "gone from the list" is the forbidden "vanished" trigger |
| **Claude Code sessions API** `GET https://api.anthropic.com/v1/code/sessions?limit=100` (what the CLI itself calls for `--teleport`; OAuth bearer of the account, `anthropic-version: 2023-06-01`) | one item per Remote Control / cloud session: `id: cse_<X>` (= the `session_<X>` in the claude.ai/code URL and in `bridgeSessionId`), `title`, **`status: active \| archived`**, `worker_status`, `connection_status`, `updated_at` | **yes**: `archived` is set by the archive action only. Idle, completed (`post_turn_summary.status_category`), disconnected and rate-limited sessions keep `status: active` |

Evidence (read-only GET with codebox's default account, 2026-11-25 ~16:00 UTC): 100 newest items = 85 archived, 15 active. Every live
codebox tmux session is `active` (e.g. `manager`, `mac-archive-sync-20261125`, `stb31-wake-check-20261125`); the sessions the owner
archived today are `archived`, including codebox ones already parked (`docs-game-bot-story`, `ble-remote-recovery-20261125`) and Mac ones.
22 archived titles match a `mac:` row name from `stalls.jsonl` exactly after slugging, for example `BLE remote panel and pairing handover`
↔ `mac:BLE-remote-panel-and-pairing-handover-0ef772`, `Bluetooth remote panel button history` ↔
`mac:Bluetooth-remote-panel-button-history-a55888`, `Tooltip helper and message deletion` ↔ `mac:Tooltip-helper-and-message-deletion-fca43c`.
Two titles exist twice (`Badge tooltip removal`, `Add stb31+ to vpt-pi3 with iTrans and BLE`), both copies archived.
One archived item was still `connection_status: connected`: archive does not always stop the process, so `status` is the field, not the
connection. No owner action was needed to observe it.

Match rule (`archive-sync.js`):

1. A `mac:` row that carries its Remote Control URL (`remote_control_url`, now sent by the Mac hook from the transcript's `bridge_status`
   line) matches by id only: `session_<X>` ↔ `cse_<X>`.
2. Otherwise by title: the row's session title slug equals the slug of the API title, and **every** listed session with that title is
   archived (two sessions with one title: nothing happens until both are archived).
3. The row's last stop is not later than the archive (`updated_at` + 60 s): a row that posts again after its archive (unarchived,
   or a process that kept running) stays.
4. codebox tmux sessions: archived when `bridgeSessionId` maps to an archived id, or the 4090 transcript line as before; they then go
   through the existing `autoParkArchived` checks (idle, no lease, no running job) and are parked (resumable), never killed.

Access: the token is the account's own OAuth access token on codebox (`<config dir>/.credentials.json`, every account of
`claude-accounts.json`), read in memory for this GET only: never logged, stored, printed or refreshed (the CLI refreshes it; an expired
token skips that account until the CLI renews it). Switch: `manager.json` `archiveSync:false`.

## What shipped

See REFERENCE.md "Archived in the Claude app". Code: `archive-sync.js`, `parking.js` (`autoParkArchived` cloudArchived), `server.js`
(`archiveSyncTick` every 60 s, `autoParkTick` every 30 s), `remote-stops.js` (row title), `scripts/mac-stop-hook.sh` (bridge URL from
the transcript; the Mac copy picks it up at the next hook install, the title match works without it).
