# Nightly RTSP check and replacement (owner, 2026-11-11)

Owner: "send a worker every night, MiniMax, to check the RTSP video and replace the stream that is not working."

| Piece | Where |
|---|---|
| Check one or all streams | `scripts/agent/rtsp_check.py` |
| Policy, replacement, journal | `scripts/agent/rtsp_replace.py`, data `config/rtsp-pool.json` |
| The nightly job | `systemd/rtsp-nightly.timer` + `.service` -> `scripts/rtsp-nightly/run.sh` -> `cbsession -p minimax` with `scripts/rtsp-nightly/prompt.md` |
| Tests | `test/rtsp-check.test.js` (fake ffprobe/ffmpeg, fake lease, fake host-config server) |

## The check (`rtsp_check.py`)

Per stream: `ffprobe` (10 s timeout, TCP) connects and finds a video stream (codec, resolution), then `ffmpeg` decodes 12 frames
as `framemd5`: the md5s must differ and the pts must advance, otherwise the stream is `frozen`. Statuses: `ok`, `no_connect`,
`no_video`, `frozen`, `timeout`, `unverified` (a loopback source on a host with no ssh alias: only the host can reach it).
`rtsp_check.py URL...` checks URLs, `--inventory` checks every `DEVICE<n>_VIDEO=rtsp(s)://` of the hosts of the configured servers
(read through `GET /server/settings/host-config`). `--json` for JSON. Exit 0 all ok, 1 not ok, 2 nothing checked. Every printed
or journaled string goes through `redact()` (`user:pass@` becomes `***@`).

The probe runs from the host when an ssh alias is configured for it (the host's network is the one that matters, and a loopback
source is only reachable there). Not `ffmpeg -t 3`: an RTSP stream's first pts is the publisher's uptime, so `-t` cut every frame on
the live mediamtx smoke stream (found while building this).

An inventory error (a server, or one of its hosts, that does not answer the host-config GET) skips that host for the night and is
reported, never retried in a loop: it is in the run's stdout (`ERROR <server>/<host>: <Error>`) and in the report's `errors` array.
The journal keeps the per-stream check events, not the inventory errors, so a night's report file is where the errors are read.

## Policy (`rtsp_replace.py`, data in `config/rtsp-pool.json`)

| Source kind | Not ok |
|---|---|
| `loopback` (127.0.0.1 / localhost: the mediamtx `smoke` loop) | replaced from the pool |
| `public` (host is in the pool file) | replaced from the pool |
| `ip_camera` (anything else: owner hardware) | **reported only, never replaced** |

- Only pool entries with a `vetted` date are replacement candidates, and a candidate is probed again right before use. A
  `loopback` entry is valid only on the hosts listed in the env var its `hostsEnv` names (`RTSP_LOOPBACK_HOSTS`, private config: the hosts running `vpt-rtsp`).
- At most `maxReplacementsPerNight` (3) per UTC day (counted from the journal), and only in `live` mode. `dry` (the default) probes
  and reports what it would do and writes nothing.
- Replacement, all inside `vpt-lease run <env> <host> --kind host --max-wait 3 -- ...` (BUSY: the command never runs, nothing is
  touched, journaled `lease_not_granted`):
  1. GET the full current host-config; refuse unless the device exists and is an rtsp source.
  2. Payload backup `<state>/rtsp-nightly/backups/<host>-<ts>.json` (mode 0600: it holds camera credentials, never the journal). The
     host also writes its own `.env.backup.<ts>` on every save.
  3. POST `/server/settings/host-config` with **all** `devices` of the GET, one `DEVICE<n>_VIDEO` changed. Never `devices:{}` or a
     partial set: the host deletes every `DEVICE<n>` it is not sent (bug-591e8166). Read back and diff: same devices, same other fields.
  4. `POST /server/system/controlHostService {service: vpt-stream, action: restart}` (the allowlisted routine path).
  5. After 15 s `rtsp_check` the new source. Any failure: POST the backup devices back, restart, journal `rolled_back`.
- Journal `<state>/rtsp-nightly/journal.jsonl` (redacted), daily `report-<date>.json`; `<state>` is `$GHOSTY_STATE_DIR` (default
  `~/.local/state/ghosty`). The report carries `hosts` (`walked`: hosts the servers listed, `read`: hosts whose config
  answered) next to `streams` and `errors`, so a night with no rtsp device says how much was looked at instead of
  looking like an empty inventory.
- Adding a pool source: probe it from a host that will use it, then set `vetted` to the date. The probe must run on that host: a
  loopback source is only reachable there, so `rtsp_check.py --host <host> <url>` (its ssh alias comes from `RTSP_CHECK_SSH`;
  `--ssh <alias>` names the alias directly) plays it where the host plays it. Without an alias the answer is `unverified`, never `ok`.
  On 2026-11-11 the public candidates (`rtsp.stream`, the Wowza demo) were not reachable from codebox or three lab hosts (port 554
  blocked or the streams gone), so none is vetted: only `smoke` (on the one lab host that runs `vpt-rtsp`) is. Until a public source is vetted, a dead public
  stream is reported as "no vetted pool source plays now" on every host without `vpt-rtsp`.

**Policy decision (manager, 2026-11-11): the pool is loopback-smoke only.** Public RTSP on 554 is blocked from codebox and three lab hosts, so no public source is vetted; a dead public stream is reported, not replaced, and a `smoke` replacement only happens on a host listed in `RTSP_LOOPBACK_HOSTS`. A public source joins the pool only after `rtsp_check.py` plays it from a host that will use it (any port, or RTSP over HTTP/TCP tunnelling, as long as the probe passes).

## Schedule and mode

`rtsp-nightly.timer`: **05:45 UTC** daily (`Persistent=true`). After the nightly fleet validation (leases 23:58, runs from 00:30, morning
report 05:15), clear of the 00:30 host cron windows and of the CoC hourly tail (`:00` to about `:38`), 45 min before the Pokemon
review (06:30) and the CoC review (07:30). Mode comes from `<state>/rtsp-nightly/mode` (`dry` unless it holds `live`). The first live
night is the manager's switch after reading one dry report: `echo live > ~/.local/state/ghosty/rtsp-nightly/mode`; back with `echo dry >`.

The session is MiniMax started by `cbsession` from the `~/ghosty-sessions` checkout (it makes its own worktree). It runs
`rtsp_replace.py`, reads the report, writes one line to the manager as the first line of its STATUS when a stream was replaced,
rolled back or a camera is down, and files `found-bug` for a camera down or a rollback.

## Private config (not in the repo)

`~/.config/rtsp-nightly/env`, sourced by the session: `RTSP_CHECK_SERVERS="<label>=<server url>,..."` (one per backend server), `RTSP_LEASE_ENV` (the `vpt-lease` environment of the hosts, default
`node1-vpt`: it lists the hosts of every server), `RTSP_CHECK_SSH="<host>=<ssh alias>,..."`, `RTSP_LOOPBACK_HOSTS="<host>,..."` (where the `smoke` source exists), optional `RTSP_CHECK_TOKEN_CMD`
(default `~/virtualpytest/scripts/agent/auto_sign_token.sh`), `RTSP_POOL_FILE`, `RTSP_SETTLE_SECONDS`.

`RTSP_CHECK_SSH` is what makes the pool usable: a loopback candidate is skipped without an ssh alias to the host that runs it
(`unverified`, never `ok`), so with it unset every down stream is only reported. The live path also needs `vpt-lease` on the PATH of
the session: `~/.local/bin` is where `cbsession` puts the agent tools, and the night otherwise reports "the lease command could not
be run" and touches nothing.

## Install (user timer, host-unit routine path: reviewed and merged repo change, nothing replaced)

    ln -s ~/ghosty-sessions/systemd/rtsp-nightly.service ~/.config/systemd/user/   # after replacing /home/<user> in a copy, or copy instead of link
    ln -s ~/ghosty-sessions/systemd/rtsp-nightly.timer ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now rtsp-nightly.timer
    systemctl --user list-timers rtsp-nightly.timer

Rollback: `systemctl --user disable --now rtsp-nightly.timer && rm ~/.config/systemd/user/rtsp-nightly.{service,timer} && systemctl --user daemon-reload`.
The service file in the repo carries `<user>` placeholders (public repo): install a copy with them filled in.
