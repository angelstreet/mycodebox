# mycodebox

<div align="center">
  <h3><b>Run a dozen AI coding agents from your phone.</b></h3>
  <p>See which one needs you, answer in one tap, keep an eye on cost. Self-hosted, over your own private network.</p>
  <p>
    <a href="#quick-start"><b>Quick start</b></a> •
    <a href="#features"><b>Features</b></a> •
    <a href="docs/INSTALL.md"><b>Install (with an AI agent)</b></a> •
    <a href="docs/REFERENCE.md"><b>Reference</b></a>
  </p>
</div>

---

## What it is

If you run several coding agents at once (Claude Code, Codex, MiniMax), each in its own terminal on one machine, you
spend your day walking between windows to find the one that stopped and is waiting for you. mycodebox puts them all
on one screen, on your phone or your laptop.

Every agent session is a card that says what it is doing: working, waiting for you, or done. Tap a card to read its
last answer, type a reply, or send a quick key like yes or continue. It installs on your phone like an app and can
notify you when an agent needs you, even when the app is closed.

It runs on your own machine and is intended for private access through [Tailscale](https://tailscale.com).
Configure the listener and tailnet policy using the install guide. Optional notifications, AI review and evaluation
can send data to configured providers; agent CLIs also use their own services.

---

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <b>One board for every agent.</b><br>
      All your sessions at a glance, sorted by who needs you most. Switch to a grid or a single card, filter by project
      or agent, and pin the ones you care about.
    </td>
    <td width="50%" valign="top">
      <b>Answer from your phone.</b><br>
      Read the last reply as plain text, reply by typing, speaking or sending a quick key. Attach a screenshot by
      pasting, dropping or picking it.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>Get told when you are needed.</b><br>
      A "needs you" strip and phone notifications when an agent asks a question or stops, so work never sits still for
      hours.
    </td>
    <td width="50%" valign="top">
      <b>Priorities and pause.</b><br>
      Mark sessions P0, P1 or P2, pause one with a tap, and park sessions you are not using to free memory.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <b>Know what it costs.</b><br>
      Tokens and cost per session, project and day, plus how much of each plan's usage window you have used, so one
      runaway agent does not eat your week.
    </td>
    <td width="50%" valign="top">
      <b>An optional AI manager.</b><br>
      Sorts every stop into "safe to continue" or "needs a human", and can answer the safe ones after a countdown you
      can cancel. It is off by default and never answers about deploys, deletes, money or credentials.
    </td>
  </tr>
</table>

More, such as deploy coordination, usage reports and the session reporter plugin, is in the
[reference](docs/REFERENCE.md).

---

## Quick start

You need Linux, Node.js 20+, Git, tmux and Tailscale. Run the dashboard as the Unix user who owns your tmux sessions.

```bash
git clone https://github.com/angelstreet/mycodebox.git ~/ghosty-sessions
cd ~/ghosty-sessions
npm ci --omit=dev
HOST=127.0.0.1 AGENT_CMD_CLAUDE=claude AGENT_CMD_CODEX=codex node server.js
```

This starts a local dashboard at `http://127.0.0.1:7777`. For phone access, follow the
[install guide](docs/INSTALL.md): connect both devices to Tailscale, restrict the tailnet policy, and configure private
HTTPS with Tailscale Serve. The guide also covers direct Tailscale access, systemd, verification and optional features.

These explicit settings matter: the source otherwise listens on all interfaces, and its Claude/Codex UI launch
commands bypass CLI permission checks. Node does not automatically read `.env`.

Once connected, follow [Usage](docs/USAGE.md) to select a session, read its answer and send a reply.

---

## Is it safe?

mycodebox has no login screen. Your Tailscale network is the only gate: anyone who can reach it can type into your
agent sessions. Keep it on the tailnet and never put it on the public internet. Secrets such as notification keys stay
on your machine and are never part of the repository.

---

## Documentation

Start at the [documentation index](docs/README.md).

- [Installation and configuration](docs/INSTALL.md): Tailscale, HTTPS, service, updates and verification
- [Usage](docs/USAGE.md): first session, replies, phone features and troubleshooting
- [Repository map](docs/MAP.md): components, data flow, state and tests
- [Agent rules](AGENTS.md) and [agent contract](docs/CONTRACT.md): safety, workflow and completion checks
- [Technical reference](docs/REFERENCE.md): settings, feature APIs and implementation details
- [Handover](HANDOVER.md): development context and known limitations

## Community & support

Report bugs or ask for features on [GitHub Issues](https://github.com/angelstreet/mycodebox/issues).

## License

No license file has been added yet, so all rights stay with the author until one is.
