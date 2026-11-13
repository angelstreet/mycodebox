# mycodebox release notes

The release note of this repo (owner 2026-11-13). Every merged code change (not docs-only) adds one entry at the top of
`## Unreleased`; the done-check reads the merged diff for this file (REFERENCE "Closing review"). Entry form: one line,
what changed and why it matters, ending with `· area: <area>`.

## Unreleased

- **Done-check asks for the release note and the bug record after a code fix** — a `STATUS: done` line after a merged code integration (not docs-only) whose diff has no release-note entry and whose closing review gives no `release note none needed: <reason>`, or whose fix names no bug id in `bugs:`, is sent back once with the two asks. In plain words: a shipped fix leaves a release note and a bug record without the owner asking · area: harness
