# Nightly RTSP check and replacement (owner, 2026-11-11)

**Scope (2026-11-11, after the app showed 92 `rtsp_video` devices):** every device of model `rtsp_video` is checked, not only literal `rtsp://` sources. The model is the generic stream model: today about 66 looping local files, 25 HLS internet-TV channels, 8 with no source, 0 rtsp://. Kinds: `loopback`, `public`, `ip_camera` (rtsp), `hls`, `file`, `no_source`. **Decision (owner, 2026-11-11: "we want to identify those streams every night and fix them"):** a dead HLS channel is repaired from the free channel lists (below), only after it fails again on a re-probe 20 s later (a TV channel can blink). Files, empty sources and IP cameras are reported by name, never changed.

Owner: "send a worker every night, MiniMax, to check the RTSP video and replace the stream that is not working."

| Piece | Where |
|---|---|
| Check one or all streams | `scripts/agent/rtsp_check.py` |
| Policy, replacement, journal | `scripts/agent/rtsp_replace.py`, data `config/rtsp-pool.json` |
| The nightly job | `systemd/rtsp-nightly.timer` + `.service` -> `scripts/rtsp-nightly/run.sh` -> `cbsession -p minimax` with `scripts/rtsp-nightly/prompt.md` |
| Tests | `test/rtsp-check.test.js` (fake ffprobe/ffmpeg, fake lease, fake host-config server) |

## The check (`rtsp_check.py`)

Per stream: `ffprobe` (10 s timeout, TCP) connects and finds a video stream (codec, resolution), then `ffmpeg` decodes 12 frames
as `framemd5`: the md5s must differ and the pts must advance, otherwise the stream is `frozen`. A **file** source that opens
on a black leader (seconds of identical frames, e.g. Plan 9 on `lenovo-local-hd`) is probed again 60 s in, so a film that plays
is not called frozen (found and fixed 2026-11-11). Statuses: `ok`, `no_connect`,
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
| `hls` (http/https source) | **restore** the same channel from a new URL, else **replace** it with another channel of the same group (see "Dead HLS channels"), after a confirming re-probe |
| `ip_camera` (anything else: owner hardware) | **reported only, never replaced** |

- Only pool entries with a `vetted` date are replacement candidates, and a candidate is probed again right before use. A
  `loopback` entry is valid only on the hosts listed in the env var its `hostsEnv` names (`RTSP_LOOPBACK_HOSTS`, private config: the hosts running `vpt-rtsp`).
- Every change (restore or replace) goes through the same steps below. At most `maxReplacementsPerNight` (3) per UTC day (counted from the journal), and only in `live` mode. `dry` (the default) probes
  and reports what it would do and writes nothing.
- Replacement, all inside `vpt-lease run <env> <host> --kind host --max-wait 20 -- ...` (`RTSP_LEASE_MAX_WAIT`; the host's one `vpt-stream` unit serves every device, so it is a host claim) (BUSY: the command never runs, nothing is
  touched, journaled `lease_not_granted`):
  1. GET the full current host-config; refuse unless the device exists and is an rtsp source.
  2. Payload backup `<state>/rtsp-nightly/backups/<host>-<device>-<ts>.json` (mode 0600: it holds camera credentials, never the journal). The
     host also writes its own `.env.backup.<ts>` on every save.
  3. POST `/server/settings/host-config` with **all** `devices` of the GET, one `DEVICE<n>_VIDEO` (and on a replace its `DEVICE<n>_NAME`) changed. Never `devices:{}` or a
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
  Re-probed on the night of 2026-11-11 from `vpt-pi4` (the host that runs `vpt-rtsp`, so the best possible vantage): all three
  public candidates still time out on port 554, `smoke` still plays (h264 640x360). **The pool is not edited by the nightly**: a
  candidate that is not reachable from the host that would play it stays unvetted.

**Pool (2026-11-11): rtsp = loopback smoke only.** Public RTSP on 554 is blocked from codebox and three lab hosts, so no public rtsp source is vetted; a dead public rtsp stream is reported. HLS devices never use this pool.

## Dead HLS channels: restore, else replace from the free lists (owner, 2026-11-11)

`scripts/agent/stream_catalog.py`. The lists (`RTSP_CHANNEL_LISTS`, comma-separated paths or URLs) default to:

1. the iptv-org upstream playlist `https://iptv-org.github.io/iptv/countries/fr.m3u` (freshest URLs);
2. our verified copy, virtualpytest `docs/agent/iptv-france-streams/fr.m3u` (137 channels that played on 2026-10-16, see its
   `STREAMS.md`), read from `~/virtualpytest`.

For a dead channel, in this order, and every candidate is probed from the host before it is used (at most 8 per device):

1. **Restore**: the same channel (same `tvg-id`, else same name) under a different URL. The device keeps its name.
   Example 2026-11-11: Euronews FR, whose old `/manifest/` URL died, is listed upstream under a new `/master/.../playlist.m3u8`.
2. **Replace**: a channel of the same `group-title` (News, Music, ...), not already used on that host, not needing a special
   user agent, same resolution tag first, our verified list first. The device is renamed, its prefix kept:
   `FR Regional 3 — Littoral FM TV` (404, gone from both lists) becomes `FR Regional 3 — P2M TV (720p)`.
3. Nothing plays: reported.

Guards (found on the first real dry run, 2026-11-11):

- **Confirm before acting**: every stream that is not ok is probed again 20 s later with 3x the timeout (30 s), in dry and
  live mode alike. Pluto channels that played an hour before timed out at 10 s under load; without the re-probe the job would
  have "replaced" working channels.
- **Frozen is reported, never changed**: identical frames over ~3 s can be a still, slate or radio channel.
- **Reads retry**: a GET that gets a 5xx or a network error is retried 3 times (10, 20 s); a 502 blip from the slow pi4 server had skipped all of its hosts for the night. Writes are never retried.
- **One channel per host**: a channel picked tonight counts as used on that host, so two dead devices never get the same one.

The channel a device plays is found by its URL in the lists, else by a stream id shared with a list URL (Euronews FR's
`/manifest/<id>/...` became `/master/<id>/playlist.m3u8`), else by the part of its name after `—`, exact or as a prefix. A device whose channel
is in no list cannot be repaired (no group known) and is reported. The verified copy should be re-probed about monthly
(`STREAMS.md`); the nightly does not edit it.

## Schedule and mode

`rtsp-nightly.timer`: **05:45 UTC** daily (`Persistent=true`). After the nightly fleet validation (leases 23:58, runs from 00:30, morning
report 05:15), clear of the 00:30 host cron windows and of the CoC hourly tail (`:00` to about `:38`), 45 min before the Pokemon
review (06:30) and the CoC review (07:30). Mode comes from `<state>/rtsp-nightly/mode` (`dry` unless it holds `live`). The first live
night is the manager's switch after reading one dry report: `echo live > ~/.local/state/ghosty/rtsp-nightly/mode`; back with `echo dry >`.
The mode file held `live` on 2026-11-11 (first live night, done by hand from the `feat/rtsp-nightly-*` worktree).

### Night of 2026-11-11 (the first live one)

99 streams checked, **2 replaced**, 0 rolled back, 0 cameras down. Three passes, because two things needed a second look:

1. First pass: 99 checked, 28 ok, 11 down, 1 replaced (`vpt-nipogi/DEVICE34`, a dead HLS channel, replaced by another channel of
   the same group and renamed). The 60 file streams of `lenovo-local-hd` and `lenovo-local-low` were `unverified` (no ssh alias
   for them in `RTSP_CHECK_SSH`): they are the boxes `vpt-lenovo-2` and `vpt-lenovo-3` (hostname and machine-id checked on
   2026-11-11), and with the aliases added the night covers all 99.
2. The dead Euronews FR channel (`vpt-nipogi/DEVICE2`) was **not** repaired in the first pass: the host lease was held by another
   session for the whole 20 min wait, so the run gave up and reported it. **A busy lease costs the night one stream**: the run
   waits for the lease, then reports without touching anything, and the stream stays down until the next pass. A second pass
   with `RTSP_LEASE_MAX_WAIT=5` took the lease and restored the same channel under its new upstream URL (the device kept its name).
3. Last pass (with the fixes): 99 checked, **89 ok, 0 unverified**, 10 down (8 empty sources + 2 live channels that were frozen
   for a moment and played on the re-probe). Nothing left to repair: both replaced streams play.

The night's budget is `maxReplacementsPerNight` (3) **for the day, not for the run**: the count comes from the journal, so two
passes share it.

`lenovo-local-hd/DEVICE7` (Plan 9) was the one `frozen` file: the film opens on a black leader of 8 identical seconds and the
probe only looked at the first 3, so a file that plays fine was reported as frozen (fixed in `rtsp_check.py` the same night, with
a test). A live picture that does not move is still reported as frozen and never changed.

The run also left its scratch file (the chosen source) in the state dir, one per replacement and per night; it is now deleted
after the apply step (test asserts the state dir holds no `apply-*` file).

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

**Every host with a file or loopback source needs an ssh alias here**, or its streams are `unverified` (not checked at all, which
looks like "fine" in the report). The host name on the server and the ssh alias are not always the same string: on 2026-11-11 the
server's `lenovo-local-hd` and `lenovo-local-low` are the boxes `vpt-lenovo-2` and `vpt-lenovo-3` (hostname and machine-id checked).
`RTSP_LOOPBACK_HOSTS` names the hosts that run `vpt-rtsp` (where the `smoke` source exists). A host that is missing from
`RTSP_CHECK_SSH` is worth a look after every night: the report counts them as `unverified`.

## Install (user timer, host-unit routine path: reviewed and merged repo change, nothing replaced)

    ln -s ~/ghosty-sessions/systemd/rtsp-nightly.service ~/.config/systemd/user/   # after replacing /home/<user> in a copy, or copy instead of link
    ln -s ~/ghosty-sessions/systemd/rtsp-nightly.timer ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now rtsp-nightly.timer
    systemctl --user list-timers rtsp-nightly.timer

Rollback: `systemctl --user disable --now rtsp-nightly.timer && rm ~/.config/systemd/user/rtsp-nightly.{service,timer} && systemctl --user daemon-reload`.
The service file in the repo carries `<user>` placeholders (public repo): install a copy with them filled in.
