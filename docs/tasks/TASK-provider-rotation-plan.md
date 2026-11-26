# PLAN: unified provider / account rotation + "Move session" button

Status: **plan only, for owner review** (2026-11-26). Nothing here is implemented, nothing was restarted, no config was written.
Branch: `feat/provider-rotation-plan`. Author: plan session started by the manager.

Goal: one model for moving work between Anthropic subscriptions (default, team1, team2), Anthropic API keys
(`~/.config/anthropic/<name>.key`), Codex and MiniMax; a guaranteed fallback for the manager and for ghosty's own AI calls;
and a **Move** button on every dashboard session (provider / seat / model / effort) that carries a handover.

---

## 1. Current state (what exists today)

| Piece | Where | What it does | Limits |
|---|---|---|---|
| Claude account list | `claude-accounts.js`, `$GHOSTY_STATE_DIR/claude-accounts.json` | Accounts `default`, `team1`, `team2` (one `CLAUDE_CONFIG_DIR` each, shared `projects/` so a conversation resumes on any account). `active` = first in list order under 95 % (5 h and week) with no limit mark. | Claude subscriptions only. |
| Worker swap on limit | `server.js` `claudeLimitTick` → `swapClaudeAccount` | Pane tail matches `scanClaudeLimit` → mark account used up → park (Escape, `/exit`) → `claude --resume <id>` on the next account → `continue` after 15 s. Switch: `autoSwapSessions`. Fable resumes on `--model opus`. | **No account left = push "Every Claude account is used up: X waits" and nothing else.** Nothing types `continue` when the window resets (quota-resume is MiniMax-only). |
| Manual account move | `POST /api/sessions/:name/claude-account {account}`, card sheet `openAccountSheet` (`public/app.js`), `scripts/claude-account move` | Same park + resume, forced (kills the session's own children). | Claude → Claude only. No model / effort / provider choice. |
| Manager move | `manager-rotation.js` + `scripts/manager-fresh.sh` + `scripts/manager-command.js` | Manager is restarted **fresh** (state is in files) on the first account with headroom, on a limit stop or while idle at 95 %. Early alert when all accounts together hold ≤ 100 points of one week. | Claude subscriptions only; no account free = alert and wait. |
| Manager standby | `scripts/orchestrator-failover` (`ghosty-manager-failover.service`), `mm-manager` (MiniMax), `standby-manager.js` | ≥ 97 % or a limit stop in `manager` → wake `mm-manager` with a standby message, state file `~/handovers/notes/.failover-state` = `minimax`; < 90 % → handback note. | **The unit is `inactive` on codebox today** (`systemctl is-active ghosty-manager-failover` → inactive). It reads only `claude-rate-limits.json` (the **default** account), not the three-account view, and it decides independently of `manager-rotation.js`. |
| MiniMax limit resume | `quota-resume.js` | One Enter after the MiniMax 5 h window resets (prompt is preserved by mcode). | MiniMax only. |
| Quota readings | `quota.js` | Codex (app-server JSON-RPC), Claude (per-account status-line files), MiniMax (coding_plan/remains). | Read-only; Codex/MiniMax readings feed no rotation. |
| Session start | `scripts/cbsession -p claude|codex|minimax|opencode -m MODEL -b sub|<key>` | Starts any provider with a brief / handover (`-H`), worktree, goal, Done-when. `-b <key>` = API key via `apiKeyHelper`. | API key + interactive Claude Code is refused by the API ("Credit balance too low"); only `claude -p` works on that key. |
| Park / resume | `parking.js` | Claude (`--resume <id>`), Codex (`codex resume <id>`), MiniMax (`mcode -c`) in the same folder and tmux name. | Resume is same provider only. |
| Ghosty's own AI | `triage.js`, `router.js`, Jev, `minimax-fallback.js`, `judge-alarm.js` | OpenRouter first; no credit / breaker open → `mcode exec` (default) or `claude -p --model haiku` (`aiFallback`). | No API-key step; the ladder is two rungs. The dashboard itself (node) needs no LLM to run. |
| Effort | `conversation.js` `effortOf`, `server.js` `effortCached` | Read from the transcript, shown in the dock. | Read-only; no way to set it from the dashboard. |

## 2. Gaps

1. **Dead end when every Claude seat is out.** A worker on team1 hitting "5-hour limit, resets 1am UTC" with team2/default also out just stops; nothing resumes it at 1am (quota-resume covers MiniMax only) and nothing offers Codex / MiniMax.
2. **No cross-provider move.** The only move is Claude account A → B, same conversation. Claude → Codex / MiniMax (or back) needs a manual cbsession with a hand-written handover.
3. **No model / effort change** from the dashboard (opus high → sonnet, fable → opus is a hard-coded special case).
4. **Manager has two uncoordinated deciders** (`manager-rotation.js` for Claude seats, `orchestrator-failover` for MiniMax), and the second one is **not running** and watches only the default account. Today, with all three seats out, the manager just waits for the next reset.
5. **No rung below MiniMax for the manager**: no Codex manager, no API-key `claude -p` loop, no explicit "rules-only" mode with a single owner alert.
6. **API keys are outside rotation.** `angelstreet` / `individual` exist but only for hand-started `cbsession -b` sessions; they cannot run interactive sessions, so they can only be a headless rung, and they cost money (owner gate).
7. **Limit detection is scattered**: `scanClaudeLimit` (Claude), the quota-resume regex (MiniMax), nothing for Codex.
8. **Moves leave no common trace**: `claude-account-swap` events exist, but session history does not record "provider/model changed, conversation N → M, handover file F".

## 3. Design

### 3.1 Vocabulary

- **Seat**: one place a session can run, with its own quota. `claude:default`, `claude:team1`, `claude:team2`, `codex:main`, `minimax:main`, `api:angelstreet`, `api:individual`.
  Each seat has `provider`, `interactive` (API seats: **false**), `billing` (`plan` | `money`), `models[]`, `efforts[]`, a quota source (existing `quota.js` readers), a limit scanner.
- **Target**: `{ seat, model, effort }`.
- **Move kinds** (derived, never chosen by the user):

| Kind | When | How | Context |
|---|---|---|---|
| `in-place` | same seat, other model / effort | Claude: `/model <m>` typed in the idle pane (+ effort, see Phase 0 spike); Codex: `/model`; else falls back to `resume` | Same conversation, same pid |
| `resume` | same provider, other seat (Claude A → B), or a model change that needs a restart | Existing park + `--resume <id>` (`swapClaudeAccount`, `codexResumeCommand`) with `--model` | Same conversation |
| `handover` | other provider (claude ↔ codex ↔ minimax) | Park old (kept resumable) → write **handover pack** → `cbsession -N -n <same name> -d <same worktree> -p <prov> -m <model> -H <pack>` | New conversation, pack carries goal + state |

Name, worktree, branch, priority, goal, Done-when and time box are kept in every kind. The parked record of the old
conversation is kept so "move back" can `resume` it instead of starting over.

### 3.2 Handover pack (deterministic, no LLM needed)

The source agent is often **at its limit**, so it cannot be asked to summarise. The pack is built by ghosty from facts:

```
~/handovers/<name>.move-<ts>.md
# Handover: <name> moved <from target> -> <to target> (<why>, by <who>)
Goal / Done when / Time box        <- ~/handovers/<name>.prompt.md (goalOfPrompt) or session-history prompt_ref
Worktree / branch / git facts      <- git-facts.js: branch, status --short, last 10 commits, unpushed, open integration ids
Last STATUS line + last 3 agent messages  <- conversation.js readConversation tail (Claude, Codex rollout, MiniMax log)
Last user prompt (verbatim)        <- what it was doing when it stopped
Held leases / running jobs         <- parkFacts (listed, never released)
Previous conversation              <- provider + session id ("resume it with: ...")
Rules                              <- the cbsession preamble (AGENTS.md, ship rule, no-workers, STATUS words)
```

Optional, voluntary moves only (source not at its limit, `mode: "ask-first"`): the old agent is asked to append a
10-line "where I am" note before the park. Capped at one turn / 2 min; the deterministic pack is sent either way.

### 3.3 Fallback chains (policy, `$GHOSTY_STATE_DIR/providers.json`)

One file, read by every decider; defaults below. Order is preference; a rung is skipped when it has no login,
no headroom (≥ 95 %), or is switched off.

| Role | Chain | Transition |
|---|---|---|
| Worker (interactive) | `claude:default → claude:team1 → claude:team2` → **then policy `onAllOut`**: `wait` (default) / `codex:main` / `minimax:main` | `resume` across Claude seats (today); `handover` to Codex / MiniMax; with `wait`: one `continue` at the earliest reset (new: Claude in quota-resume) |
| Worker, return | when a preferred Claude seat frees up, a session that was moved **by the chain** to Codex/MiniMax is **not** moved back automatically (would churn); the card shows "Claude free: move back?" | owner / manager clicks Move |
| Manager | L0 `claude` seats (fresh restart, today) → L1 `minimax:main` (`mm-manager`, today's failover) → L2 `codex:main` (fresh `manager-codex` with MANAGER.md kickoff) → L3 `api:<key>` headless loop → L4 rules-only | Always a **fresh** start from files (MANAGER.md, manager-events, manager-actions); never a resume |
| Ghosty AI judges (triage, router, Jev) | OpenRouter → MiniMax `mcode exec` → `claude -p haiku` on a plan seat with headroom → `api:<key>` `claude -p haiku` → rules-only + judge-down alarm | Per call; no state |

`onAllOut` is per session (card setting) with a global default; `wait` keeps today's behaviour plus the reset resume.

### 3.4 Manager guarantee (one decider)

`manager-rotation.js` becomes the **only** decider for the manager; `orchestrator-failover` is reduced to a
token-free watchdog that calls it (or is retired once L1 lives in the server tick). Ladder:

- **L0** Claude seats: unchanged (`manager-fresh.sh`, `MANAGER_FRESH_ACCOUNT`).
- **L1** MiniMax `mm-manager`: promotion gated on `minimax-rate-limits.json` as today, but triggered from the **three-account view** (`claudeAccounts.view()` all exhausted), not the default file. The failover state file stays the single truth for `standby-manager.js` visibility.
- **L2** Codex manager: `cbsession -A -N -n manager-codex -p codex -d ~/ghosty-sessions-manager -f MANAGER-kickoff` when MiniMax is out too; same visibility rule as the standby (hidden while state ≠ `codex`).
- **L3** API-key headless loop (`scripts/manager-api-loop.sh`, new): `manager-wait.sh` batch → one `claude -p --model sonnet` call per wake with MANAGER.md + wake summary, `apiKeyHelper` on the key (interactive is refused, `-p` works). **Money rung: off by default, owner switch + daily cap** (`managerApiDailyUsd`), stops at the cap.
- **L4** Rules-only: no LLM. The deterministic paths keep running (lane, quota-resume, crash-resume, decide-policy, lease reaper); one high-priority owner push with the next reset (Paris time); auto-promotion back to L0 at the reset.
- Hand-back: when L0 has headroom, the current rung writes a handback note (L1/L2: asked; L3/L4: generated from manager-actions since promotion) and the Claude manager is fresh-started with it.

Ghosty itself (node server, systemd) needs no LLM; its guarantee is that every AI path has a rules-only answer and the judge-down alarm.

### 3.5 Unified limit detection

`providers.js` exports `limitOf(provider, paneLines) -> { limited, window?, resetsAt?, credentials? }`, wrapping
`scanClaudeLimit`, the quota-resume MiniMax regex, and a new Codex scanner ("You've hit your usage limit" / rate-limit
error lines; exact strings gathered in Phase 1 from real panes, `docs/v2/RUNTIME_FORMATS.md`). One tick
(`providerLimitTick`) replaces `claudeLimitTick` + quota-resume dispatch, keeping their caps and journals.

## 4. Move-session button: API + UI sketch

### 4.1 API

```
GET  /api/sessions/:name/move-options
  -> { current: { seat:"claude:team1", provider:"claude", model:"opus", effort:"high", state:"idle", limited:false },
       targets: [ { seat:"claude:team2", provider:"claude", headroom:{h5:12, week:40}, models:["fable","opus","sonnet","haiku"],
                    efforts:["low","medium","high","max"], kind:"resume", ok:true },
                  { seat:"codex:main", provider:"codex", headroom:{h5:0, week:32}, models:[...], kind:"handover", ok:true },
                  { seat:"api:angelstreet", ok:false, why:"API keys run headless only (claude -p)" } ],
       resumable: [ { provider:"claude", sessionId:"…", seat:"claude:team1", at:"…" } ] }   // earlier conversations of this name

POST /api/sessions/:name/move
  body { seat, model?, effort?, when: "now" | "idle" (default idle), note?: string, dryRun?: bool, resume?: sessionId }
  -> { ok, kind, from, to, handover?: "~/handovers/<name>.move-<ts>.md", parked?: {...}, killed?: [...], leases?: [...] }
  dryRun -> { ok, kind, plan: [steps], handoverPreview }
  409 { why:"busy" } when when=now is refused by a safe check; 400 unknown seat / non-interactive seat / same target.
```

- `POST /api/sessions/:name/claude-account {account}` stays as an alias (`move {seat:"claude:<id>"}`).
- `actorOf(body)` records who moved it (owner / manager / chain). Managers' sessions route to the manager ladder instead (fresh start), never park.
- Journal: `session-history` gets `kind:"session.moved"` with `from`, `to`, `kind`, `handover_ref`, `prev_session_id`; a `health:session-moved:<name>` manager event.
- CLI: `scripts/session-move <name> --to codex[:model] [--effort high] [--now] [--dry-run]` (wraps the API, for the manager).

### 4.2 UI (card ⋯ menu and dock: "Move…", replaces "Switch account")

```
┌ Move "fix-login-bug" ──────────────────────────────────┐
│ Now: Claude · Team joachim · opus · high   (5h 100% ⛔)  │
│                                                         │
│ Provider  [ Claude ] [ Codex ] [ MiniMax ]              │
│ Seat      ○ Default      5h 96%  wk 70%   used up       │
│           ● Team contact 5h 12%  wk 40%                 │
│ Model     [ opus ▾ ]     Effort ( low | med | ●high )   │
│                                                         │
│ ✓ Same conversation (resume on Team contact)            │
│   — or, for Codex/MiniMax —                             │
│ ⚠ New conversation with a handover  [ preview pack ]    │
│                                                         │
│ When  ● when idle   ○ now (stops its running tasks)     │
│                                   [ Cancel ] [ Move ]   │
└─────────────────────────────────────────────────────────┘
```

- One primary action (Move). The kind line comes from `move-options` (`dryRun`), so the user sees "same conversation" vs "handover" before clicking.
- Disabled rows carry their reason (no login, used up until 01:00 Paris, headless only).
- "Earlier conversations" (collapsed): resume a previous one on its own provider (moves back without a new handover).
- Card chip after a move: `moved from Claude·team1 (limit)`; with `onAllOut` ≠ wait and a freed Claude seat: "Claude free — move back?".
- Light / dark per `web-ui-ux-rules`; mockup first (`vpt-ui-restyle` flow), the UI review gate reviews it.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Two deciders move the same session (limit tick + owner click, or rotation + failover for the manager) | One in-flight move per session (`running` map, as manager-rotation has); manager: single decider (3.4) |
| Two agents in one worktree after a handover move | Park must succeed (pid gone) before the new start; the move refuses otherwise |
| Replay of an old limit stop after resume triggers a second move | Keep `scanClaudeLimit`'s "last agent output" rule; apply the same rule in the Codex / MiniMax scanners; test with replayed panes |
| Handover loses context (cross-provider) | Deterministic pack with verbatim last prompt + git facts; old conversation stays resumable; "move back" resumes, not re-hands |
| Codex / MiniMax sessions have no ghosty-reporter plugin, no Remote Control | Board falls back to pane parsing (as today for those agents); the card marks them; brief preamble carries AGENTS.md rules |
| API-key spend runaway (manager L3, judges) | Off by default; owner switch; daily cap; every call logged with cost; this is a **money** item for the owner |
| Effort control differs per CLI / version | Phase 0 spike; effort chips only shown for providers where it is verified |
| Moving a session that holds a lease | Leases listed in the result, never released (today's rule); `when: idle` default |
| Tests touching live state | Temp `GHOSTY_STATE_DIR`, throw-away tmux sessions, no live cards at phone width (memory rules) |
| MiniMax / Codex login expired | A rung with an expired login is skipped (`credentials` from the scanner), feed item, never answered automatically |

## 6. Phased steps (sizes, tests)

Sizes: S ≤ ½ day, M 1–2 days, L 3+ days. Each phase ships through the lane on its own; nothing after Phase 0 changes behaviour until its switch is on.

| # | Size | Step | Tests |
|---|---|---|---|
| 0 | S | **Quick wins, no new model.** (a) Claude limit with no seat left: one `continue` at the earliest reset (extend `quota-resume.js` to Claude panes, same caps). (b) Failover reads the three-account view, not the default file. (c) Re-enable `ghosty-manager-failover` (needs sudo: owner / manager action). (d) Spike: how the installed Claude Code / Codex set effort and model in a live pane (record in RUNTIME_FORMATS.md). | `test/quota-resume.test.js` Claude cases (limit + reset, replay not resumed, paused not resumed); `test/manager-failover.test.js` with three rate files |
| 1 | M | `providers.js`: seat registry (wraps `claude-accounts.js`, adds codex / minimax / api seats from existing quota readers and `~/.config/anthropic/*.key` names, never contents), `limitOf()`, `providers.json` policy with defaults; read-only `GET /api/providers`. | `test/providers.test.js`: seat list from fixtures, interactive=false for API seats, chain resolution skips no-login / ≥ 95 % / off, Codex + MiniMax limit scanners on captured panes incl. replay |
| 2 | M | Handover pack builder (`move-handover.js`) + `GET move-options` + `POST move {dryRun:true}`. | Fixture transcripts (Claude jsonl, Codex rollout, MiniMax), temp git repo → pack snapshot test; options for each current/target pair; no secrets in pack (key file contents never read) |
| 3 | M | Move executor: `in-place`, `resume` (wraps `swapClaudeAccount`, `codexResumeCommand`), `handover` (park → `cbsession -N` same name / worktree). History `session.moved`, manager event, alias for `/claude-account`, `scripts/session-move`. | Unit with fake tmux / exec (like `test/parking.test.js`); one real e2e on a throw-away tmux session in a temp worktree: claude → codex → resume claude back; refusal when park fails |
| 4 | S–M | UI: Move sheet (mockup → build), card chip, "move back?" hint. | `test/buttons.test.js`-style DOM tests; headless Playwright on a worktree via route-override (`reference_ui-repro-playwright`), desktop + phone width, light + dark; no live card opened |
| 5 | M | Worker chain on exhaustion: `providerLimitTick` replaces `claudeLimitTick` + quota-resume dispatch; per-session `onAllOut`. Default `wait` = today + Phase 0 resume. | Tick tests: all Claude out + `onAllOut=codex` → handover move once; `wait` → no move, continue at reset; paused / held untouched; one move per stop |
| 6 | M | Manager ladder L1–L4 under one decider; `manager-api-loop.sh` (L3, off); rules-only mode (L4) + alert; handback. | `test/manager-rotation.test.js` ladder table (each rung out → next); L3 never starts with the switch off or over the cap; drill on a throw-away session with `MANAGER_FRESH_KICK` (never the live manager) |
| 7 | S | Ghosty judges ladder: add plan-seat `claude -p` with headroom and the API-key rung (off) to `minimax-fallback.js`; docs (REFERENCE "Provider rotation", MAP row, skill `codebox-sessions` move section). | `test/minimax-fallback.test.js` rung order; docs-links test |

Order of value: 0 (stops the dead end now) → 1–3 (button backend) → 4 (button) → 5 → 6 → 7.

## 7. Decisions

1. **Money (owner, open):** may API keys be used as automatic fallback rungs (manager L3, judges), and with which daily cap? Until the owner answers: **off by default** (manager 2026-11-26).
2. **Worker default `onAllOut`: `wait`** — decided by the manager 2026-11-26.
3. **Manager ladder: MiniMax (L1) before Codex (L2)** — decided by the manager 2026-11-26.
4. **Re-enabling `ghosty-manager-failover` (owner, open):** needs sudo on codebox, or Phase 6 moves L1 into the server tick and the unit is retired. The manager takes it to the owner.

Implementation starts only after the owner's go.
