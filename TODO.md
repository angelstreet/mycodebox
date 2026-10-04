# TODO

Not urgent. Newest decisions first.

## Ops
- [ ] **Tailscale cert renewal** — the Let's Encrypt cert in `certs/` expires **2027-01-01**. Add a monthly job that reruns
      `tailscale cert --cert-file certs/cert.pem --key-file certs/key.pem <host>.ts.net` and restarts `ghosty-sessions`.
- [ ] **MiniMax quota** shows "login expired" until `mcode` refreshes its login (open a MiniMax session once). The quota reader never refreshes it on purpose.
- [ ] **APK**: keep the signing keystore (`~/apk/android.keystore`) and its password file safe; a rebuild is only needed if the manifest / icon / package changes (the app loads the live site).

## Features offered, not built
- [ ] "Load older" button for session history beyond the 1000 captured lines (fetch more only on demand).
- [ ] Join hard-wrapped lines in the reader's "earlier conversation" view (the last-reply view already does).
- [ ] Tokens view without cache reads ("in + out only" toggle) — cache reads dominate the totals.
- [ ] Attach a task document manually to a session that is not named `taskNN`.
- [ ] Close buttons on the "more" menu and the text-size popover (today they close by tapping outside / Android back).
- [ ] Minimum pane size when a card claims a size (see "narrow panes" below).

## Known behaviour worth fixing
- [ ] **Narrow panes**: "Fit sessions to cards" resizes a session's tmux window to whichever card showed it last, so a phone viewing the 4-up / 16-up grid
      leaves sessions at ~23-27 columns (e.g. 24x8). The agent then hard-wraps its output at that width, which looks bad in the reader and in the review page.
      Options: server-side floor (e.g. 60 cols x 12 rows) in `resizeSession`, or only fit when a card is in single-card view.
- [ ] MiniMax `task41` shows no model name (its footer has no `✦ M3` marker yet).

## Needs a real screen (shipped untested visually)
Top bar + "more" menu, usage sheet views (Overview / Over time / Trending / Sessions), reader tables, task doc view,
new-session project dropdown, Android back button, mobile layouts, web push in the APK.
