# Starting agent sessions with `cbsession`

`scripts/cbsession` is the one way to start an unattended agent session in tmux on the host that runs mycodebox. Every
tmux session shows on the dashboard; Claude sessions also get Remote Control, so they appear in the Claude app.

Install once, from the checkout: `ln -sf "$PWD/scripts/cbsession" ~/.local/bin/cbsession` (`~/.local/bin/cbsession`
should be a symlink to the repo script, not a copy).

```bash
cbsession -n NAME -d DIR [-p claude|codex|minimax|opencode] [-m MODEL] (-H HANDOVER | -f PROMPT_FILE | -t "TEXT") [-x]
```

| Flag | Meaning |
|---|---|
| `-n` | session name (`A-Z a-z 0-9 _ -`, max 40); also the Remote Control name |
| `-d` | working directory (an existing checkout) |
| `-p` | provider, default `claude` |
| `-m` | model: Claude `haiku`/`sonnet`/`opus`/`fable`/id; MiniMax `MiniMax-M3` (default and only MiniMax model); Codex model; OpenCode `provider/model` |
| `-H` | handover file: the session reads it, summarises state and open items, proposes the next step, then waits |
| `-f` / `-t` | prompt file (verbatim) / prompt text (with `-H` it adds an instruction) |
| `-x` | dry run: write the prompt and launch files, print them, start nothing |

Environment: `MCODE_NODE_DIR` (Node bin dir put on `PATH` for `mcode`, default `$HOME/.local/node-v24.21.0-linux-x64/bin`),
`GHOSTY_STATE_DIR` and `GHOSTY_PORT` (default `$PORT`, else 7777) for the history report below.

The prompt and launch files go to `~/handovers/<NAME>.prompt.md` and `<NAME>.launch.sh`. After starting, the script posts
a `session.started` record (provider, model, cwd, prompt file, handover, Remote Control link) to the loopback-only
`POST /api/history/started`, authenticated with the reporter token in the state dir. If that fails it prints one warning
and the launch still succeeds; the dashboard then records the session as started by `unknown`.

Owner limits (no shared hosts, deploy, push, merge or secrets; a worktree before changing code) are part of the handover
prompt. Send more text to a running session with separate calls: `tmux send-keys -t NAME -l "text"; sleep 1; tmux send-keys -t NAME C-m`.
For a bounded, testable job use a V2 task instead (`POST /api/v2/tasks`, see `docs/v2/`).
