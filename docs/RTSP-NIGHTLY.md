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
- Replacement, all inside `vpt-lease run <env> <host> --kind host --max-wait 5 -- ...` (`RTSP_LEASE_MAX_WAIT`; the host's one `vpt-stream` unit serves every device, so it is a host claim) (BUSY: the command never runs, nothing is
  touched, journaled `lease_not_granted`). The wait is short on purpose: a busy host must not hold the whole night. A repair the
  lease blocked is **retried at the end of the night** with the long wait (`RTSP_LEASE_RETRY_MAX_WAIT`, 20 min), when the other
  work is done and the host is more likely free. Without that retry a busy lease cost the night a stream (2026-11-11: the dead
  Euronews FR channel on `vpt-nipogi/DEVICE2` was repaired on the second pass, bug-241e5753).
  The three ways a replacement can fail are **not** the same thing, and the journal keeps them apart:
  - `lease_not_granted`: the claim was refused (BUSY, fenced, `E_NOT_AUTHORITY`): the command never ran, nothing was touched.
    Only this one is retried at the end of the night.
  - `lease_not_available`: the `vpt-lease` CLI itself is missing (nothing ran).
  - `apply_failed`: the lease **was** granted but the apply step died (the host may be half-changed: the payload backup is in
    `backups/`). The apply step always leaves a result behind, and the run also reads the lease CLI's own "lease … held,
    running …" line, so a failed apply is never reported as a refused lease.
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

## What the app shows: the tile snapshot and black pictures (owner, 2026-11-11)

The owner still saw a black BFM2 tile while its source played. A source check alone cannot see that, so every device is
also checked where the app looks: the tile's snapshot `/host/<host>/stream/<captureN>/thumbnails/latest.jpg`, read
through the device's own server (the same path the browser uses, the auto-sign token as header). Per device, column `capture`:

| capture | Meaning | What the job does |
|---|---|---|
| `ok` | fresh (≤ `RTSP_STALE_SECONDS`, 120 s) and **not** black (at least one of the two pictures is bright) | nothing; it also turns an `unverified` file device into a checked one |
| `black` | **both** pictures are dark: the thumbnail (90th-percentile luma, ffmpeg `signalstats` YHIGH, under `RTSP_BLACK_LUMA` 32, on **three snapshots 10 s apart**) **and** the live video (the newest HLS segment, what the browser plays). Not the mean: a dark, letterboxed Sintel scene averaged under 24 and was called black | the source is measured too, **for an HLS channel**, over a **window** of frames (2 a second for 6 s, sampled again 10 s later if the window is dark — the first frame of a channel says nothing about the channel: a Pluto TV ad break opens on 17/255, bug-5ab9d8b4): source bright = the host's capture is wrong, **reported**; source black too = the channel itself is black, **repaired from the lists** like a dead channel (only when `capture-mode` is `live`). A **file** is only reported, never blamed on the capture side: a dark frame of a looping clip is not a dead stream (2026-11-13) |
| `stale` | older than 120 s | reported: the host stopped writing it (capture side) |
| `multi_audio` | the host stream's newest segment (`segments/output.m3u8`, what the live player loads) carries more than one audio track | reported: hls.js buffers nothing, the live tile is black while the snapshot is fine. Fixed on the host 2026-11-12 (bug-ea31641c, virtualpytest 0d73213: `run_ffmpeg.sh` maps one usable audio track); a host still showing it runs the old script: restart `vpt-stream` there under the host lease (a host deploy does not restart it) |
| `missing` / `unreachable` | 404, or the server did not answer after 3 tries | reported |

The `capture` column reads **both** pictures of a tile (2026-11-13, bug-6b227d92): the thumbnail and the live video. The
thumbnail alone cannot judge a tile, because a looping clip moves: the thumbnail is one moment of the clip and the live video
another. So a dark thumbnail alone is reported as a **note** ("the tile's snapshot was dark but the live video plays"), not as a
broken tile; `black` means both are dark. The live layer is read from the host's newest HLS segment (`segments/output.m3u8`),
the same bytes the browser's player loads; they are fetched once per device and the audio-track count comes from them too.
Its luma is the **brightest** picture that segment holds (the 90th percentile over its frames), not its first frame: a
segment's first frame can be a transition frame and read black while the tile plays. The report carries both luma's per
device (`luma` = the thumbnail, `live_luma` = the live video).

The capture-driven repair has its own switch, `<state>/rtsp-nightly/capture-mode` (`dry` unless it holds `live`), so it
runs report-only until one clean night has been read (manager, 2026-11-11). The report ends with a
`tile snapshots (what the app shows): {...}` count.

What this still does not see: a tile that is black only in the browser for a reason outside the host (session cookie, CORS,
the page itself). The 2026-11-11 BFM2 case had two layers: first, the snapshot was bright and fresh, but the browser could not mint the host-session cookie on the
other server (CORS refused the new `X-Control-Session` header), virtualpytest BUG-8e34e51d, fixed and deployed the same night (the snapshot now shows); second, its live player stayed black
because of the 4 audio tracks (`multi_audio` above, bug-ea31641c), fixed 2026-11-12. A browser check of the
device page is the only proof for that layer (`vpt-headless-verify` skill, section 2c).

### Proving a tile is fixed (lesson of 2026-11-12)

A tile has **two pictures**, and "fixed" needs both, each with a screenshot looked at:

1. **Snapshot** (`<img>`, `thumbnails/latest.jpg`): what a page with more than 16 tiles shows. Proven by the report's
   `luma` per device and by a headless screenshot of the card (the `capture` column reads both pictures, so `ok` alone
   does not say the snapshot is bright).
2. **Live video** (`<video>`, `segments/output.m3u8`): what a page with 16 tiles or fewer shows, and any tile on hover.
   Proven only by hovering the card (`page.mouse.move` to its centre, 15 s), then `video.readyState` 4 and a screenshot
   that is not black. `readyState` 1 with nothing buffered is the `multi_audio` signature. The nightly reads this layer
   too (`live_luma`), but a segment's first frame can be a transition frame: the browser proof is the one that counts.

The 2026-11-11 close checked the snapshot only and called BFM2 fixed; the owner's view (a filtered page, live video) was
still black. Check the view the owner screenshot shows, not the default one.

After a host-side fix: the host deploy installs the script but does **not** restart `vpt-stream`; until it restarts, the
old ffmpeg command keeps running. Check `journalctl -u vpt-stream` for the new log line (`Audio map for deviceN: -map 0:1?`),
else restart it under the lease: `vpt-lease run node1-vpt <host> --kind host -- ...` with `systemctl restart vpt-stream`
over ssh, or the server's `/server/system/controlHostService` (what `rtsp_replace.py` uses) for a host ssh does not reach.

## Schedule and mode

`rtsp-nightly.timer`: **05:45 UTC** daily (`Persistent=true`). After the nightly fleet validation (leases 23:58, runs from 00:30, morning
report 05:15), clear of the 00:30 host cron windows and of the CoC hourly tail (`:00` to about `:38`), 45 min before the Pokemon
review (06:30) and the CoC review (07:30). Mode comes from `<state>/rtsp-nightly/mode` (`dry` unless it holds `live`). The first live
night is the manager's switch after reading one dry report: `echo live > ~/.local/state/ghosty/rtsp-nightly/mode`; back with `echo dry >`.
The mode file held `live` on 2026-11-11 (first live night, done by hand from the `feat/rtsp-nightly-*` worktree) and again on
2026-11-12, the first night the session ran the job end to end (99 checked, 90 ok, 0 replaced).

### Night of 2026-11-11 (the first live one)

99 streams checked, **2 replaced**, 0 rolled back, 0 cameras down. Three passes, because two things needed a second look:

1. First pass: 99 checked, 28 ok, 11 down, 1 replaced (`vpt-nipogi/DEVICE34`, a dead HLS channel, replaced by another channel of
   the same group and renamed). The 60 file streams of `lenovo-local-hd` and `lenovo-local-low` were `unverified` (no ssh alias
   for them in `RTSP_CHECK_SSH`): they are the boxes `vpt-lenovo-2` and `vpt-lenovo-3` (hostname and machine-id checked on
   2026-11-11), and with the aliases added the night covers all 99.
2. The dead Euronews FR channel (`vpt-nipogi/DEVICE2`) was **not** repaired in the first pass: the host lease was held by another
   session for the whole 20 min wait, so the run gave up and reported it. **A busy lease cost the night one stream**: the run
   waits for the lease, then reports without touching anything, and the stream stays down until the next pass. A second pass
   with `RTSP_LEASE_MAX_WAIT=5` took the lease and restored the same channel under its new upstream URL (the device kept its name).
   The lease wait is now short by default and the blocked repair is retried at the end of the night, so this no longer needs a
   second pass (bug-241e5753, bug-b7f346c7, fixed the same night).
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

### Night of 2026-11-12 (live, run by the nightly session)

99 streams checked, **90 ok, 9 down**, **0 replaced**, 0 rolled back, 0 cameras down, 0 unverified. 15 hosts walked, 15 read,
**no inventory error** (every server and every host answered the host-config GET).

- The 9 down: 8 devices with an empty source (`vpt-nipogi` DEVICE4, 5, 6, 17, 22, 23, 24 and `vpt-pi4` DEVICE2; reported by
  name, never changed) and `vpt-lenovo5/DEVICE1`, frozen on the first probe and playing on the confirming re-probe (a slow
  channel, nothing touched). No stream was really down, so nothing had to be replaced and the pool was never used.
- What the app shows (tile snapshots): 79 ok, 3 black, 10 multi_audio, 6 unknown, 1 missing.
  - The 10 `multi_audio` tiles are the known host-side bug (bug-ea31641c): the host stream carries every audio track of a
    multi-rendition HLS master, so the browser's live player can show a black tile while the source plays. All 10 were opened
    in the browser: 9 render a live picture (tile brightest pixel 66-222, the video advances), and **BFM2** (`vpt-lenovo5/DEVICE1`,
    4 tracks) is black in the browser (tile brightest pixel 16/255) while its host snapshot is bright (157): the bug reproduces
    tonight, the browser layer is not fixed.
  - `vpt-nipogi/DEVICE31` (`FR Series — MDL`) is black for good: the channel's own picture is black (host snapshot and source
    frame, luma 16 under 32; still black on a re-check after the run). A headless browser check of the app confirms it: the
    tile renders a black video area (brightest pixel 16/255) while the card chrome is white; the `<video>` inside the tile
    decodes (readyState 4, 320x180) but shows nothing. With `capture-mode` still `dry` the nightly reports it and changes
    nothing; the manager can switch `capture-mode` to `live` (tonight was a clean night) and the channel is then replaced from
    the free lists (bug-de449145).
  - `lenovo-local-low/DEVICE23` and `DEVICE36` were black at 05:48 and fresh and bright (luma 113 and 85) on a re-check 17 min
    later: a transient dark frame on the host capture side, not a dead channel (idea filed, bug-9b0cd7b5).
- The pool was not touched: re-probed from `vpt-pi4` (the host that runs `vpt-rtsp`), `smoke` plays (h264 640x360), and the three
  public candidates still time out on port 554 from `vpt-pi4` and from codebox, so nothing new is vetted (bug-c7c2bb0e,
  bug-6b79b048).

### Night of 2026-11-13 (live, run by the nightly session)

103 streams checked, **93 ok, 10 down**, **0 replaced**, 0 rolled back, 0 cameras down, 0 unverified. 16 hosts walked, 16 read,
**no inventory error** (every server and every host answered the host-config GET).

- The 10 down: 8 devices with an empty source (`vpt-nipogi` DEVICE4, 5, 6, 17, 22, 23, 24 and `vpt-pi4` DEVICE2; reported by
  name, never changed) and 2 live channels that timed out once and played on the confirming re-probe (`vpt-nipogi` DEVICE10 and
  DEVICE27, both `jmp2.uk`; nothing touched). Nothing was really down, so nothing had to be replaced and the pool was never used.
- 103 streams and 16 hosts instead of 99 and 15: `vpt-lenovo1` now carries 3 file devices (`eggs_loop`, `cars_loop`,
  `tennis_analytics_loop`).
- What the app shows (tile snapshots): 94 ok, 2 black, 6 unknown, 1 missing.
  - **No `multi_audio` tile left**: the 10 tiles of 2026-11-12 (`vpt-lenovo5`, `vpt-lenovo6`, `vpt-nipogi`) all read `ok`, and no
    device carries more than one audio track any more. The host-side fix of bug-ea31641c has landed everywhere, so no
    `vpt-stream` restart was needed tonight.
  - The 2 black, opened in the browser (hover, live layer):
    - `vpt-nipogi/DEVICE31` (`FR Series — MDL`) is black for good: the host snapshot and the source frame are black (luma 0)
      and the browser shows the same black picture with the station logo. bug-de449145 is still open, `capture-mode` is still
      `dry`, so the nightly reports it and changes nothing.
    - `lenovo-local-low/DEVICE36` was black at 05:48 (luma 14) and bright again a few minutes later (luma 85), the black
      reading having moved to `lenovo-local-low/DEVICE23` (luma 31): a dark frame of a looping clip, not a dead stream
      (bug-9b0cd7b5). Both tiles play live on hover in the browser (`readyState` 4, the clock advances ~3 s) and show the
      clip's own content (a film frame, then its dark credits). The nightly judges "black" on the thumbnail alone, and a
      looping clip moves: the thumbnail is one moment of it, the live tile another.
    - `BFM2` (`vpt-lenovo5/DEVICE1`) plays its source and its snapshot is bright, but its live tile is still black in the
      browser (`readyState` 1, the clock runs): the known audio/video drift of bug-c54ea30f, not the multi_audio of
      bug-ea31641c (the host segment now carries one audio track).
- The nightly now reads **both** pictures of a tile before calling one black (bug-6b227d92, fixed and merged the same
  night): a dry validation run against the fleet turned `lenovo-local-hd/DEVICE9` (thumbnail luma 19, live video 33) into a
  note instead of a false alarm, while `lenovo-local-low/DEVICE36` (12 / 19) and `vpt-nipogi/DEVICE31` (0 / 16) stayed black,
  which is what they are. The browser confirms the note: on hover `PD Movie 9 — Häxan (1922)` plays (`readyState` 4, the clock
  advances ~3.2 s) and shows the film (22.7% of the picture above the luma threshold), so the dark thumbnail was a dark moment
  of the clip. A black verdict now needs three signals to agree (dark thumbnail, dark live video, black source frame), so the
  capture-driven repair is more conservative than before, never less.
- The pool was not touched: re-probed from `vpt-pi4` (the host that runs `vpt-rtsp`), `smoke` still plays (h264 640x360) and the
  three public candidates still time out on port 554, so nothing new is vetted (bug-c7c2bb0e, still `wontfix`).

Two things the night of 2026-11-11 left open were closed on 2026-11-12 (both with tests):

- The **end-of-night retry** of a repair the first lease wait did not get was verified for real: the real `vpt-lease` CLI against
  the real registry (a short host claim on `vpt-pi4`), the host busy for the first wait, then the retry took the lease and replaced
  the stream. The journal shows `lease_not_granted` and then `replaced`.
- A **refused lease** and a **failed apply step** are now two different outcomes in the report and the journal
  (`lease_not_granted` / `apply_failed`): before, both said "host lease not granted", which sent the reader (and the end-of-night
  retry) after the wrong cause. The apply step always leaves a result behind, and the run also reads the lease CLI's own
  "lease … held, running …" line, so a failed apply is never reported as a refused lease. The lease CLI prints that line **before**
  the command runs, so the run reads its whole output, not the tail of it.

### Night of 2026-11-14 (live, run by the nightly session)

103 streams checked, **94 ok, 9 down**, **0 replaced**, 0 rolled back, 0 cameras down, 0 unverified. 15 hosts walked, 15 read,
**no inventory error** (every server and every host answered the host-config GET). The journal holds 103 `check` events for
this night and nothing else: no `replace`, no `rolled_back`, no `lease_not_granted`, no `apply_failed`.

- The 9 down: 8 devices with an empty source (`vpt-nipogi` DEVICE4, 5, 6, 17, 22, 23, 24 and `vpt-pi4` DEVICE2; reported by
  name, never changed) and `vpt-nipogi/DEVICE27`, which timed out once and played on the confirming re-probe (nothing touched).
  Nothing was really down, so nothing had to be replaced and the pool was never used.
- What the app shows (tile snapshots): 93 ok, 2 black, 6 unknown, 1 stale, 1 missing.
  - The 1 stale tile, `vpt-nipogi/DEVICE21`, was a **host-side stall**, and it was repaired live. The capture's ffmpeg was wedged
    at `frame= 2 fps=0.0`, its log kept moving (so the stale-log watchdog was blind) and its folder held **0 `.ts` segments**; the
    tile's snapshot was 28 739 s old. `vpt-stream` was restarted on that host under its lease
    (`vpt-lease run node1-vpt vpt-nipogi --kind host`), the capture wrote segments again (723 `.ts`, thumbnail age 0 s) and the tile
    plays in the browser (`readyState` 4, the clock advances 84.5 s → 88.5 s, no failed HLS request, a live frame on the
    screenshot). The watchdog that should have done this never fired: see bug-555e3c05 below.
  - The 2 black tiles:
    - `vpt-nipogi/DEVICE7` (Pluto TV) was a **false black**. The nightly judged the channel on its **first frame** only, and that
      frame was the dark start of an ad break (the report reads `source_luma` 27; the nightly's own three probes of that source
      read 144.0 / 17.0 / 116.0). The channel itself is bright: over a window its brightest frame reads 103-119 (windows of
      1-30 s), and 140-194 on the re-check after the fix. The browser confirms the channel plays: `readyState` 4, the clock
      advances 149 s → 152 s, and the tile shows a movie frame. The nightly called the channel black because of that one frame —
      bug-5ab9d8b4, fixed the same night (the channel is now judged over a window; a channel that is really black stays black,
      see `DEVICE31`).
    - `vpt-nipogi/DEVICE31` (`FR Series — MDL`) is black for good: host snapshot 0, live layer 16, source 16 — and 16 over every
      window (1, 3, 6, 12 and 30 s), so the window does not hide it. bug-de449145 is still open and `capture-mode` is still `dry`,
      so the nightly reports it and changes nothing. This device has no device-control card, so there is no browser proof for it.
- The pool was not touched: re-probed from `vpt-pi4` (the host that runs `vpt-rtsp`), `smoke` plays (h264 640x360) and the three
  public candidates still time out on port 554, so nothing new is vetted (bug-c7c2bb0e, still `wontfix`).
- Two defects the night turned up, each fixed on its own branch with a test:
  - **bug-555e3c05** (VirtualPyTest): the capture watchdog compared the age of the newest `.ts` segment only when there *was* a
    segment, so a grabber that wrote none was never restarted — exactly the `DEVICE21` case above, which stayed stale for 8 h
    until a human restarted the service. The grabber's own start is now the clock for that case.
  - **bug-5ab9d8b4** (mycodebox): the nightly judged a live channel on its first frame only — the `DEVICE7` case above. The
    channel is now judged over a window of frames, so an ad break no longer reads as a dead channel.

## Private config (not in the repo)

`~/.config/rtsp-nightly/env`, sourced by the session: `RTSP_CHECK_SERVERS="<label>=<server url>,..."` (one per backend server), `RTSP_LEASE_ENV` (the `vpt-lease` environment of the hosts, default
`node1-vpt`: it lists the hosts of every server), `RTSP_CHECK_SSH="<host>=<ssh alias>,..."`, `RTSP_LOOPBACK_HOSTS="<host>,..."` (where the `smoke` source exists), optional `RTSP_CHECK_TOKEN_CMD`
(default `~/virtualpytest/scripts/agent/auto_sign_token.sh`), `RTSP_POOL_FILE`, `RTSP_SETTLE_SECONDS`, `RTSP_LEASE_MAX_WAIT` (5 min: the first wait for a
host lease), `RTSP_LEASE_RETRY_MAX_WAIT` (20 min: the end-of-night retry of a repair the first wait did not get).

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
