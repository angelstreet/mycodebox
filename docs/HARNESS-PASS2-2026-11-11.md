# Harness pass 2, 2026-11-11: STATUS honesty, grant notice, guards, fix claims

Second pass after [the harness review](HARNESS-REVIEW-2026-11-11.md), asked by the owner: "done and goal not achieved should not be a done
status: it should be blocked or failure, which means the agent needs help and the manager should look at it." Evidence first, from the
ledgers of 2026-11-11 (`stalls.jsonl`, `manager-actions.jsonl`, `manager-wakes.jsonl`, `manager-events.jsonl`, the lease registry events and
the Claude transcripts of the day). Sanitised: no host addresses, roles or codenames only. Times UTC.

## Evidence

| Case | What the data shows | Item |
|---|---|---|
| opus-openexit | 17:16 `STATUS: done — anchor not valid on stb4 today, so v2 stays and no v3 was built ... goto Home from Apps failed 2/2` | 1 |
| task208-pick5 | 00:40 `... play_radio, play_replay and play_vod are on prod and green on stbv1` with no link or run id (later lines with report links pass) | 5 |
| content-mobile, kpi-zap-fix | `done — ... goal not met: 5 distinct contents played (not 10)`; `done — ... the 5-zap proof is incomplete` | 1 |
| mobile-orchtnet-owner | ticket t-779ac666 granted 16:38 (lease 1a79f027); last stop 16:29 `needs-manager: ticket ... is stuck`; told by the manager at 17:09 | 2 |
| kpi-web, content-mobile | `cat > upd.sql <<EOF update navigation_edges set ... EOF` then psql over the jump host (5 commands); content-mobile `update virtual_scripts` the same way (4) | 3a |
| fp194-opus-status | `L=$(vpt-lease claim ... | head -1); ...; ssh <host> 'sudo -n systemctl restart vpt-host'`: the claim result was never checked | 3b |
| web-kpi-unblock | `curl -X POST .../server/settings/host-config -d '{"host":{...},"devices":{}}'` twice: every DEVICE key of the host .env deleted | 3c |
| bug-e1c49ec8 | a Mac session and a worker fixed the same bug, lane conflict on the same test file | 4 |
| MiniMax share | `minimax:share:<session>` alert 6 times for one session at 90-92% (10:23 to 14:23) | 6 |
| Manager wakes | 271 wakes, 210 did nothing ($58.8 of $86.2); 52 of the no-op wakes were about integration results, 33 deploys, 26 lease notices | 6 (proposed) |

## Design (smallest first) and what was built

1. **STATUS vocabulary** (`status-honesty.js`, `stall.js`, `done-check.js` (F)/(G), rule text in AGENTS.md, `cbsession`, MAC-HOOK, REFERENCE
   "STATUS vocabulary"). New verdict `STATUS: failed — goal not achieved: <why> · tried: <list>` parsed as a manager item (`needs_manager` +
   `failed`), never a finished turn. `done` needs `goal: achieved · evidence: ...`. The goal is the prompt's `Goal:` line (`cbsession -g`) or
   its first task line. The done-but-failed detector reads the claim part of the done line clause by clause: strong phrases fire alone, soft
   ones only when the clause names the goal. One wake per done line, one manager event. **Built.**
2. **Grant notice** (`own-jobs.js` `grantOf`, parked-wake path, `parkedWake` switch). A `needs-manager` / `failed` stop naming a ticket is
   parked for the grant only; a grant to this session's own lease is told after 5 min even when the pane is busy. Dry rows `parked_wake_dry`
   carry `why: grant` and the text. **Built; `parkedWake` stays `dry` (the owner flips it to `live`).**
3. **Guards** (`scripts/session-guard-hook.js`, `scripts/install-guard-hooks.js`): raw SQL writes, unchecked or lease-less vpt-* restart / stop,
   host-config saves without `devices`; owner override `GHOSTY_GUARD_OVERRIDE` from the environment only. **Built and installed** in the codebox
   `~/.claude/settings.json` (it runs the live checkout's copy, so it is active from the deploy of this branch).
4. **Fix claim** (`found-bug --claim <id> [--release]`, `POST /api/bugs/<id>/claim`, 2 h, exit 3 when held by another; Mac token path; claims
   in `found-bug list`). **Built**, client scripts version 3 (Mac: `found-bug --self-update`).
5. **Evidence rule** (`done-check.js` (G)): a done claim of green / pass / proven with no link, run id, uuid or frame / audio file gets one
   warning. **Built.**
6. **From the data** (frequency x cost): (a) MiniMax share alert keyed on a sliding window start: **fixed** (`newShareAlerts` keys on the
   session and the time of its last alert); (b) a strict multi-host catch-up deploy blocks claims on every host it spans for 30 min while one
   host is leased (`readyCatchUp` in `lease-service.js`): filed as bug-341e7e84, **fixed** the same evening by deploy-claim-gate-fix
   (int-1a1cbfa071dec326e: a blocked multi-host catch-up starts on the free hosts and re-queues the busy one alone); (c) no-op manager wakes for
   integration results and lease notices: filed as bug-d7a8b50a, a **duplicate** of TASK-239 wake economy (ace149f ignores routine
   external-result, share and session notices; the live session manager-wake-filter owns the rest).

## Numbers (replays of 2026-11-11)

- **Done but failed**: 184 distinct done stops of 66 sessions -> 17 stops of 5 sessions flagged (opus-openexit, content-mobile, kpi-zap-fix,
  fix-ci-parallel-timing, website-lane-learnfit); all 5 read by hand as goal not achieved or the goal itself unverified. kpi-stb (measured on four
  boxes, zap / radio filed with owners) is not flagged: its open rows are scoped and owned, and its problem that day was git (the existing
  done-check). With one wake per line, the 5 sessions would have had 5 to 7 wakes and the manager 5 events.
- **Proof without evidence**: 21 stops of 10 sessions; task208-pick5's 00:40 line and opus-openexit's "3/3 green" among them.
- **Grant notice**: 80 ticket grants to codebox sessions; 6 went to a session whose last stop named that ticket; 5 resumed on their own within
  0-4 min (no wake with the 5 min grace); 1 (mobile-orchtnet-owner) would have been told at 16:43 instead of 17:09.
- **Guard**: 6,789 Bash commands in the day's Claude transcripts -> 12 refused, all real (above); 0 false refusals after two rule fixes found
  by the replay (a heredoc that writes a test file, a manager message that mentions the route).

## Mac vs codebox

| Part | Codebox | Mac |
|---|---|---|
| `failed` verdict, done-but-failed, proof evidence | parser + done-check (tmux panes) | the Stop hook posts the text, the server parses `failed` the same way; the done-check does not see Mac panes, so the rule text in the MAC-HOOK snippet is the guard |
| Rule text | AGENTS.md, `cbsession` preamble (every provider and prompt source) | MAC-HOOK snippet for `~/.claude/CLAUDE.md` (owner pastes it) |
| Grant notice | parked wake | none (no way to wake a Mac session from the server) |
| Guard hook | installed | proposed: `install-guard-hooks.js --checkout <mac checkout>` by the owner |
| Fix claim | `found-bug --claim` | same script over the token (`found-bug --self-update` brings v3) |

## Not verified

- The detectors were replayed on stored excerpts (the stall row's tail), not on live panes; a long done line that wrapped differently in a pane
  may read differently.
- The grant notice replay used the registry's grant events and the stall ledger, not a live dry night; the lease view's `sinceMs` field on the
  registry host's answers was not checked live.
- The guard's lease-less restart rule was not replayed with the leases of the time (they were not recorded per command).
- Nothing was run on the Mac.
