# The harness: map, as-is process, proposal, audit (2026-11-28)

Scope: the AI-agent harness on codebox, meaning mycodebox (this repo, `ghosty-sessions`), the VirtualPyTest agent files
(`vpt:` = `~/virtualpytest`) and the global Claude config (`~/.claude`). It changes no code and no rule.
**[as-is]** = read in the code or measured on 2026-11-28, with `file:line`. **[proposal]** = not built, needs a decision.

## 1. The harness in one picture [as-is]

| Actor | What it does | Model | Where |
|---|---|---|---|
| Owner | Asks, answers hard-floor items, corrects decisions afterwards | - | dashboard, voice, phone push |
| ghosty server | Lists tmux sessions, sends keys, receives hook reports, emits manager events | none | `server.js`, `docs/MAP.md:10-20` |
| Manager agent | Claude Code session `manager`. Answers `needs-manager`, starts workers, closes the sessions it started | Sonnet (`launch-config.js:45-47`) | kickoff `scripts/manager-fresh.sh:102`, manual `~/vpt-manager/docs/tasks/TASK-44-MANAGER.md` (6.2k words) + `-REF.md` (5.2k) |
| Stop watcher | Classifies each stop and proposes or sends safe replies. This is rules, not an LLM | Jev on the VPT server (OpenRouter); MiniMax fallback; AI triage `simulate` by default | `manager.js:1-18`, `:90` |
| Workers | Coding sessions in tmux with Goal / Done when / Time box, started by `cbsession` | Claude Code default = Opus (`~/.claude/settings.json:12`); subagents Sonnet (`scripts/cbsession:54-55`); Fable only with `-F` (`:51-53`) | `scripts/cbsession` |
| Dashboard "New session" | Same as a worker, two clicks | Sonnet preselected, Fable offered without a gate (`new-session.js:14,17`) | `new-session.js` |
| V2 task engine | Contract → developer → checks → independent reviewer → integrate | routed per risk (`orchestration/router.js:23`) | `orchestration/`. On (`GHOSTY_V2=1`) but **unused**: 3 tasks, last 2026-10-14 (`~/.local/state/ghosty/v2`) |
| Integration lane | `integrate request` → merge floor → tests → UI review → push → CI → deploy → notify | **none** (regex and git only) | `integration-lane.js`, `merge-policy.js:680-695` |
| UI reviewer (VPT) | Screenshot and script checks on graphical diffs, before merge, after deploy and nightly | Haiku judge, advisory (`vpt:scripts/review/ui_review.py:32`, `ui_review_gate.py:382-385`) | `ui-review-lane.js` |
| Done-check family | Checks the closing STATUS line and types push-back text into the session | none (regex) | `done-check.js`, `goal-check.js`, `proof-risk.js`, `status-honesty.js` |
| Suggestion triage | Answers improvement suggestions yes or no | Opus `claude -p`, no tools (`suggestion-triage.js:102-121`) | server |
| ask-opus | Second opinion when the manager doubts | Opus `claude -p` (`scripts/ask-opus.js:2-11`) | manager |
| Bug intake / bug drain | `found-bug` proof gate; timer starts drain workers | MiniMax or Sonnet (`scripts/bug-drain-tick.js:136-143`); **mode `dry`**, journal 2026-11-27 | `found-bugs.js`, `docs/BUG-DRAIN.md:11` |
| Hooks | Stop hook blocks a turn without a STATUS line once (`claude-plugin/ghosty-reporter/report.ts:78-96`); kill-guard, worktree-guard, session-guard (`~/.claude/settings.json` hooks) | none | plugin + `~/.claude/hooks` |
| Code reviewer agent | `review:reviewer`, a one-pass diff review against VPT contracts | caller's model | `vpt:claude-mods/review/agents/reviewer.md`. **On request only** ("Use only when the user asks", line 3) |
| Usage meter | Ledger, waste detectors, loop scan | none | `usage/waste.js:8-18`, `usage/loops.js:8` |

```text
owner ask ──> session (owner-started)  or  manager ──cbsession──> worker (worktree, Goal/Done when/Time box)
                                                                   │ code, tests (touched only)
                                                                   ▼
                     integrate request ──> lane: floor regex → npm test / VPT gate → UI review (VPT, Haiku)
                                           → push (CAS) → CI → deploy → line typed back into the session
                                                                   ▼
STATUS: done ──> done-check (regex): closing review · release note · proof-by-risk · goal check
             ──> reflection: suggestions → Opus triage → owner (doubt/floor only)
             ──> manager-started: manager gets <s>:ready-to-close and closes · owner-started: nobody closes
```

## 2. As-is process per request type [as-is]

| Request | Who handles | Model | Gates that really run | How it ends |
|---|---|---|---|---|
| **Question** (owner → session) | The session it was typed into | That session's model | None | STATUS line |
| **Question** (session → someone) | `needs-manager` → manager; floor topic → owner ask; manager-started sessions never ask the owner (`AGENTS.md:149-157`) | Manager Sonnet; Opus via ask-opus on doubt (`TASK-44-MANAGER.md:208-218`) | Owner-floor regex (`owner-asks.js:270`) | Answer typed back |
| **Doc** | One session, `docs/` branch | Session model | Time box 30 min (`scripts/cbsession:264-274`); lane docs-only fast path: no CI, no deploy (`integration-lane.js:1147-1162`); no review | done-check; closing review lists docs |
| **New task / feature** | One session, no workers unless `-K` (`AGENTS.md:86-90`) | Opus by default (cbsession) or Sonnet (dashboard) | Done when required (`cbsession:254-262`); touched tests (`scripts/test-run.js:1-8`); lane merge floor; **no code review**; VPT UI review on `frontend/src`; proof by risk; goal check; reflection | `done` + closing review; then suggestions; closed by manager or left open |
| **Bug, inside own task** | The finder fixes it, never files it (`AGENTS.md:51`) | Same | As feature | `bugs: fixed — <what>` |
| **Bug, unrelated** | Small: finder fixes it in its own worktree. Large: `found-bug` with proof (`scripts/found-bug:4-11`) → manager sends it back or starts a worker | Manager picks: "MiniMax with a Sonnet gate, else Sonnet" (`TASK-44-MANAGER.md:170`) | `--checked-main`, `--tried`, `--why-not-fixed` | `found-bug --resolve` |
| **Bug drain** | Timer 5×/day | MiniMax ≤80% window, else Sonnet (`bug-drain-tick.js:26-27`) | - | **Dry: logs "started", starts nothing** |
| **Small UI label / style** | One session | Same | proof-risk classifies `cosmetic` → no e2e (`proof-risk.js:56-58`); VPT UI review still runs (Haiku, advisory) | done |
| **Verification / e2e** | The session itself (skill `vpt-headless-verify`) | Same | Required only for a **frontend** logic diff: headless mention + screenshot newer than the deploy + non-localhost URL (`proof-risk.js:84-94`, `docs/REFERENCE.md:2688-2690`) | done-check push, then `proof-risk:<s>` manager event |

**Gaps and contradictions found**

1. **No code review on the normal path.** The lane never calls a model on the diff (`merge-policy.js:717-748` is used only by the manager); `review:reviewer` runs only when asked; V2's independent reviewer (`orchestration/goal-loop.js:1218`) is unused.
2. **Backend changes have no proof requirement.** proof-risk applies only when web UI files changed (`docs/REFERENCE.md:2688`). A backend bug fix ends `done` with no API smoke.
3. **"Run tests yourself" vs "run no tests".** The VPT ship rule says to run the touched tests yourself (`vpt:AGENTS.md:5`). VPT DECISIONS says a small change runs **no** tests by hand (`vpt:docs/agent/DECISIONS.md:101-103`).
4. **Manager model.** Code runs Sonnet (`launch-config.js:45-47`). The manual says "Sonnet by default" (`TASK-44-MANAGER.md:3`) and also tells you to launch with `--model opus` and that "Opus 5.5 minimum" (`:11`, `:15`, `:24`).
5. **Two defaults for a new session.** cbsession inherits Opus (`settings.json:12`), the dashboard preselects Sonnet (`new-session.js:17`). Fable is gated in cbsession (`:51-53`) but not in the dashboard (`new-session.js:14`).
6. **Reflection rule differs per repo.** mycodebox has Opus triage and manager-answers-for-its-sessions (`AGENTS.md:147`, `:149-157`). VPT still says "Only the owner answers ... a manager never does" (`vpt:AGENTS.md:118`).
7. **Owner-started sessions never close.** No tick closes a session (`worker-auto-close.js:7-10`, `AGENTS.md:180-184`). Only manager-started sessions get `ready-to-close`.
8. **Bug drain is shipped but dry.** The policy text reads as if it were live.

## 3. Proposed process [proposal]

### 3.1 Phases and models

Cost per million context tokens (`docs/token-audit-20261128.md`, (e)): Fable $1.24, Opus $0.36, Sonnet $0.28. One Fable turn costs about 3.4 Opus turns. Sonnet and Opus cost almost the same per context token, so the choice between them is about quality and plan share, not price.

| # | Phase | Default | Escalate to | Script instead of a model? |
|---|---|---|---|---|
| 0 | Intake: classify request type and change type, write Goal / Done when | Haiku, or a script from cbsession flags | Sonnet when the brief is vague | Partly: cbsession already refuses a start with no Done when (`:254-262`). Add `--kind doc\|bug\|feature\|style\|infra` |
| 1 | Conception (plan, design, interfaces) | Opus for feature / backend / auth / infra; skipped for doc / style / small bug | Fable only with `-F`, for a design the manager has already marked hard | No |
| 2 | Development | Sonnet | MiniMax when ≤3 files and ≤200 lines (rule exists: `router.js:76-114`); Opus for cross-cutting, auth, infra; Codex as a second builder | No |
| 3 | Code review | **Different family from the developer**, fresh context, diff + contracts only: Codex `gpt-6.1-sol` or Opus reading `review:reviewer`'s checklist | Opus for auth / infra | Lint, size and secret gates stay scripts (`vpt:scripts/review/review_gate.sh`) |
| 4 | Test / verification | Scripts: touched tests, pre-push gate, CI | Haiku judges screenshots (as today); Sonnet runs a full e2e session only for feature / auth | Mostly scripts (see matrix 3.2) |
| 5 | Goal check against Done when | **Script**: run each Done when line that is a command or URL; `goal-check.js` is already regex (`:124-142`) | Haiku only for "observation" lines | Yes |
| 6 | Improvement suggestions | One Opus `-p` call (exists: `suggestion-triage.js`), max 3 items | - | No |
| 7 | Cleanup and close | **Script**: worktree removal (exists: `worktree-cleanup.js`), lease release, close once `done` is accepted with no suggestion open and no job running | - | Yes. For owner-started sessions it needs an owner decision (the 2026-10-30 rule forbids auto-close) |

Phases 0, 5 and 7 cost no frontier tokens. Phase 3 is the only new model spend, about one 20-40k-context call per merge, and it skips doc, copy and style changes.

### 3.2 Verification level by change type

| Change type | Unit / touched tests | API smoke | Headless screenshot | Full e2e browser | Code review | Example |
|---|---|---|---|---|---|---|
| Docs, skill, release note | - | - | - | - | - | this file |
| Copy / label | pre-push gate | - | UI review (exists) | - | - | button text |
| Style / CSS | pre-push gate | - | UI review + 1 screenshot, light and dark | - | - | spacing, colour |
| Small bug, frontend | touched | - | yes, deployed URL | the one flow | yes | broken filter |
| Small bug, backend | touched | **yes, 1 call on the deployed host** | - | - | yes | 500 on an endpoint |
| Feature | area tests | yes | yes | yes, the main flow | yes, Opus or Codex | new page |
| Backend / DB / API | area tests | yes | - | only if UI uses it | yes | new route |
| Infra / deploy / systemd | `node --check`, dry run | health endpoint after deploy | - | - | Opus + manager approval (exists for infra paths: `integration-lane.js:683-689`) | lane change |
| Auth / secrets / permissions | area tests | yes, including a deny case | yes | yes, login flow | Opus + owner floor | token flow |

proof-risk already separates cosmetic from fix/feature for the frontend (`proof-risk.js:46-61`). The proposal adds the backend rows (API smoke) and the review column.

### 3.3 Per request type, to-be

| Request | Path |
|---|---|
| Question | No session. The manager answers on Sonnet, or Haiku for "where is X" lookups. ask-opus on doubt. Floor topics go to the owner. Closes at once |
| Doc | Sonnet session, no conception, no review, docs-only lane, script close |
| Task / feature | Opus conception → Sonnet (or MiniMax) build → Codex/Opus review → scripted tests and verification per matrix → scripted goal check → Opus suggestions → script close |
| Bug | Sonnet (MiniMax if small) reproduces first: the repro command becomes a Done when line → fix → review → the same command passes after deploy |
| Label / style | Sonnet or MiniMax, UI review only, no e2e, no code review |
| Verification only | Haiku or Sonnet runs the recipe (`vpt-headless-verify`) and returns evidence; no code change |

## 4. Instruction-file audit [as-is, measured]

### 4.1 What a session's first call reads (p50 56k)

Measured with `claude -p` probes (Sonnet, "reply OK") and the `instructions` / `skill_listing` attachments of 2026-11-27 transcripts. VPT worktree session, interactive: 55.2k first call.

| Block | Tokens | How measured |
|---|---|---|
| Claude Code system prompt + built-in tool schemas | ~22.4k | `-p` in an empty dir with skills off |
| Skills and commands list (45 user skills + built-ins) | 5.3k (empty dir) to 9.1k (VPT worktree) | with vs without `--disable-slash-commands` |
| Interactive-only: claude.ai Artifact / Docs tools, agent list (~1.1k), deferred tool names, remote control, session context | ~15k | interactive 55k vs `-p` 40k in the same dir |
| Project auto-memory: VPT `MEMORY.md` 1,531 words | ~2.1k | transcript `instructions` attachment |
| cbsession brief (p50 532 words VPT, 381 mycodebox) | ~0.5-0.7k | first user message, 404 sessions |
| Global `CLAUDE.md` (24 words) | <0.1k | file |
| Repo-dependent rest (git status, environment) | ~6k | `-p` VPT worktree minus parts; not isolated |

The floor with no repo is 24.1k (107 `task263-night` sessions). **AGENTS.md is not in the 56k.** Claude Code loads only the global `CLAUDE.md` and `MEMORY.md` in a worktree (transcript instructions list). The VPT `CLAUDE.md`, which imports AGENTS.md, is gitignored and lives only in the main checkout (`vpt:CLAUDE.md:10-13`). mycodebox has no CLAUDE.md. The brief therefore says "read it before your first message" (`scripts/cbsession:153`, `:218`), which costs a Read of another 3.5k (VPT) or 6.6k (mycodebox) tokens and is not enforced.

### 4.2 Files and duplication

| File | Words | ~Tokens (×1.35) | Loaded |
|---|---|---|---|
| mycodebox `AGENTS.md` | 4,921 | 6.6k | Read on instruction; Codex auto |
| `vpt:AGENTS.md` | 2,596 | 3.5k | main checkout auto; worktree on instruction |
| `vpt:CLAUDE.md` | 289 | 0.4k | main checkout only |
| `vpt:docs/agent/DECISIONS.md` | 8,896 | 12k | on demand |
| Manager manual + REF + ai-manager | ~17k | ~23k | manual (8.3k) at every fresh start (`manager-fresh.sh:102`) |
| cbsession full rule text (repos without the rules) | ~2,200 | 3k | every brief there (`cbsession:220-294`) |
| Skill descriptions | 1,931 | 2.6k (real ~5-9k) | every session, every repo |

| Rule | Copies |
|---|---|
| Ship rule | `AGENTS.md:7-12`, `vpt:AGENTS.md:5-10`, `vpt:CLAUDE.md:23-25`, every brief (`cbsession:147`) |
| Bug you find / found-bug | `AGENTS.md:51-52` and `:126-133` (one ~400-word paragraph), `vpt:AGENTS.md:12-15` |
| Closing review | `AGENTS.md:134-145`, `vpt:AGENTS.md:105-116`, `docs/REFERENCE.md:2646` |
| Reflection after done | `AGENTS.md:146-148`, `vpt:AGENTS.md:118` (stale, see 2.6) |
| STATUS words | `AGENTS.md:18-30` (seven words), `vpt:AGENTS.md:83-103` (eight forms, incl. `handoff`), `docs/STATUS-TABLE.md` |
| Worktree rule | `vpt:CLAUDE.md:20-25`, `vpt:AGENTS.md:28-36`, brief step 0 (`cbsession:148`) |

**Is VPT AGENTS.md too big?** At 3.5k tokens it is not: the 2026-11-16 move already cut it to an index. One defect: cbsession decides "rules are in the repo" by grepping four phrases (`cbsession:132-135`), and VPT matches them on its **index line** (`vpt:AGENTS.md:43`), not on the rule text. A VPT session gets the short brief and is pointed to a file that points on to DECISIONS.md. **mycodebox AGENTS.md is too big** (6.6k): one-line paragraphs of 300-400 words (`:130-131`, `:146-147`) mix rule, rationale and history.

### 4.3 Trim list

| # | Cut | Saving per session start |
|---|---|---|
| T1 | Make the rules load automatically: commit a 5-line `CLAUDE.md` with `@AGENTS.md` in both repos (VPT keeps its local file), or have cbsession inject one "core rules" block (~600 words) | Replaces a 3.5-6.6k Read with a ~0.8k block; rules always present |
| T2 | mycodebox AGENTS.md to ≤1,500 words: keep the rule lines, move dates, rationale and incidents to REFERENCE | ~4.5k when read |
| T3 | Move ~15 personal, non-dev skills (konto, kozy, wakfu, CoC, LoL, youtube, ai-bot-story, promo, concept-card, docs-one-image, remotion, drone, flappy, lmstudio, game-procedure-cache) out of `~/.claude/skills` into a separate config for the sessions that need them; scope the device skills to VPT | ~1-2k measured share (32 niche skills = 1,826 tokens of description by words) |
| T4 | Shorten descriptions over 45 words (top: `app-map-exploration` 60, `ui-review` 55, `clashofclans-player` 52) | ~0.3k |
| T5 | Turn off claude.ai connectors and the Artifact tool for tmux workers (account setting or `--strict-mcp-config` and disallowed tools in cbsession) | up to ~10k of the 15k interactive-only block (to verify) |
| T6 | Manager kickoff: read §0-§7 only (it already says so), split out the 2026-10 history | ~3-4k per fresh start |
| T7 | Drop the ship rule from the brief where AGENTS.md is loaded (after T1) | ~0.1k |

T1 + T3 + T5 bring a VPT worker's first call from ~56k to about 42-45k plus guaranteed rules. Over the 15.4k Claude calls of 48 h this is a cached-context saving of a few %. The bigger win is that the rules actually reach the model.

## 5. Global audit: top 10 issues beyond tokens [as-is findings, proposed fix]

| # | Issue | Evidence | Fix | Owner |
|---|---|---|---|---|
| 1 | No automatic code review before merge | `merge-policy.js:717-748` unused by the lane; reviewer "only when the user asks" | Lane step: cross-family review call for code diffs above the "small" size; returns on a real finding (phase 3) | code + owner decision |
| 2 | AGENTS.md rules are not loaded in Claude worktrees; the rules-in-repo check passes on a pointer | transcripts; `cbsession:132-135`; `vpt:AGENTS.md:43` | T1; grep the rule text, not the index | code |
| 3 | Backend fixes need no proof | `docs/REFERENCE.md:2688` | Extend proof-risk: backend diff → one API call on the deployed host, quoted | code |
| 4 | Conflicting test rule in VPT | `vpt:AGENTS.md:5` vs `DECISIONS.md:101-103` | Ship rule: "run the touched tests unless the change is small (DECISIONS)" | manager |
| 5 | Manager model documented three ways | `launch-config.js:45-47`, `TASK-44-MANAGER.md:3,11,15` | Owner picks one; fix the manual | owner → manager |
| 6 | Model defaults split between cbsession (Opus) and dashboard (Sonnet); Fable ungated in the dashboard | `settings.json:12`, `new-session.js:14,17`, `cbsession:51-53` | One default (Sonnet), Fable behind the same gate | code |
| 7 | Reflection rule stale in VPT | `vpt:AGENTS.md:118` vs `AGENTS.md:147-157` | Replace with a pointer to one text | manager |
| 8 | Owner-started sessions are never closed; idle ones keep context, worktrees and leases | `worker-auto-close.js:7-10`, `AGENTS.md:180-184` | Script close for accepted `done` with nothing open, as an owner opt-in per session | owner |
| 9 | Shipped-but-off components: V2 engine (3 tasks, last 2026-10-14), bug drain `dry`, `router.js` "SHADOW ONLY" (`:1-3`) but imported by `decide-policy.js:11`, `merge-policy.js:9` and `manager.js:56` | state dir, `docs/BUG-DRAIN.md:11` | Mark each "live / dry / retired" in MAP.md; retire V2 or route one task kind to it | owner + manager |
| 10 | Waiting costs model calls: `manager-wait.sh` re-run 20-81 times per session; 10.8% of calls are sub-150-token polls | `docs/token-audit-20261128.md` (d) | Lane and done-check wake sessions (they already type the result back); stop polling `integrate wait`; longer manager batches | code + manager |

Also noted: the goal check is regex word overlap (`goal-check.js:130`), so a reply that quotes the goal passes without the Done when commands being run. Phase 5 fixes this. `usage/prices.json` lists `fable-5-1` but no `fable-5-2`.

## 6. Next steps, PR-sized [proposal]

| # | PR | Size | Who |
|---|---|---|---|
| 1 | Committed `CLAUDE.md` (`@AGENTS.md`) in mycodebox; cbsession check greps rule text, not the index line | S | code |
| 2 | VPT AGENTS.md: fix the ship-rule test conflict and the stale reflection line | S | manager (VPT repo) |
| 3 | Manager manual: one model, matching `launch-config.js` | XS | manager |
| 4 | One session default (Sonnet) and one Fable gate for cbsession and the dashboard | S | code |
| 5 | cbsession `--kind` → time box, verification level (matrix 3.2) and review flag written into the brief | M | code |
| 6 | proof-risk backend rule: API smoke evidence for backend diffs | M | code |
| 7 | Lane code-review step (cross-family, diff only, size threshold, `dry` first, then `live`) | M | code + owner switch |
| 8 | Scripted goal check: run Done when lines that are commands or URLs; Haiku only for observations | M | code |
| 9 | mycodebox AGENTS.md to ≤1,500 words, the rest to REFERENCE | M | manager |
| 10 | Skills split (T3/T4) and worker launch without claude.ai connectors (T5), measured before and after with the `claude -p` probe of §4.1 | S | owner (personal skills) + code |
| 11 | MAP.md "live / dry / retired" column for V2, bug drain, router, triage | XS | manager |
| 12 | Owner decision: opt-in auto-close for owner-started sessions | - | owner |
