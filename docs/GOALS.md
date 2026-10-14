# Product goals

What mycodebox is for, in the owner's words first. Each goal says what is shipped and what is not; evidence lives in
the linked pages and tests, never in this file alone.

## The owner's words (2026-10-14)

> "The most difficult and constraining for me right now is to follow tasks and always answer the same questions: yes
> merge, yes push, yes deploy, yes do the recommended one. Very rarely I correct, and almost always the correction can
> come at the end, because when waiting for me we stop developing. Another issue: I need to be behind my laptop or
> phone. I need a better ability to hear and engage by voice. My goal: I go to the gym or drive and can still work."

## G1. Autonomy by default

Sessions do not stop for routine confirmations. Merge, push, deploy and "the recommended option" are decided by the
manager with an evaluation and recorded; the owner corrects afterwards. Waiting for the owner is the exception, reserved
for the remaining hard floors: deletions of data, credentials and secrets, money, customers, sudoers and units on hosts,
production database migrations (plus force-push / history rewrites, tag pushes and publishing; the full list is in
[REFERENCE](REFERENCE.md#autonomy-by-default-push-deploy-and-recommended-options-owner-2026-10-14)).

| Part | Status |
|---|---|
| Merge decisions (clean merge, tests green, no sensitive files, Jev or reasoning; journaled, feed notice) | Shipped in round 7 ([REFERENCE](REFERENCE.md#merge-decisions-and-mixed-questions-owner-2026-10-14)) |
| Information parts of mixed questions answered, only the rest escalated | Shipped in round 7 |
| Push and deploy decisions (deploy through the deploy queue, leases free, tests green, no migration, one-line rollback) | Round 8 ([REFERENCE](REFERENCE.md#autonomy-by-default-push-deploy-and-recommended-options-owner-2026-10-14)) |
| "Do the recommended option" on by default | Round 8 |
| "Correct at the end": the "Decided for you" list and daily digest with revert / correct | Round 8 |

Decision record: [OWNER_DECISIONS §14 and §15](tasks/v2/OWNER_DECISIONS.md).

## G2. Hands-free, voice-first

The owner can follow and steer the fleet by voice only (gym, driving): hear what needs them, answer by voice, hear
summaries; no screen required.

| Part | Status |
|---|---|
| Read a reply or an ask aloud (piper TTS, tap to play) | Shipped (before round 8) |
| Dictate into a session (whisper, tap to record) | Shipped (before round 8) |
| Voice mode: spoken "needs you" queue with options, spoken answer mapped to an option, spoken confirmation for sensitive options | Round 8 ([VOICE](VOICE.md)) |
| Spoken digest ("what happened in the last hour") | Round 8 |
| Headset / car buttons (Media Session), screen kept on (Wake Lock), notification actions with the screen off | Round 8, phone checks MANUAL; platform limits in [VOICE](VOICE.md) |
| A wake word, recording with the screen locked | Not possible in a browser PWA today; see [VOICE](VOICE.md#honest-limits) |

## Existing goals

| Goal | Status |
|---|---|
| Phone-first dashboard: every agent session on one screen, reply from the phone, notifications when the app is closed | Shipped ([README](../README.md), [USAGE](USAGE.md)) |
| A manager that answers the safe stops and escalates the rest, every action visible, logged and switchable off | Shipped; widened by G1 |
| Usage, cost and quota per session and project | Shipped ([REFERENCE](REFERENCE.md#usage-langfuse)) |
| Cost / quality routing between models | Router and scoring in code and tests; the manager's router is shadow only ([ROUTING](v2/ROUTING.md), [SCORING](v2/SCORING.md)) |
| V2 goal loop: a goal, deterministic checks, an independent review, an honest outcome | In code and tests, off by default (`GHOSTY_V2=1`) ([README roadmap](../README.md#current-capabilities--v2-roadmap)) |
| Session history (who started what, when, cost) | Shipped (rounds 6, 6b) |
