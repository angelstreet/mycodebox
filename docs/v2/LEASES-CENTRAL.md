# One central lease service (round 10 design)

Owner (2026-10-14): "We need to rethink the lease process and make sure our new codebox centralises it, because it is a
main point of blocking for dev, test and deployment." Addendum: "you are blocking dev with a lease when you just wait".

Status: design for round 10. The service, the compatible client and the dashboard view are built in this round; the
fleet is **not** switched over by it. The cut-over is an owner-side step described at the end.

## 1. What exists today (inventory, 2026-10-14)

| Mechanism | Where | What it does | Problems it causes |
|---|---|---|---|
| Registry CLI `vpt-lease` | the registry host, `~/bin/vpt-lease` (Python, one global `flock`, JSON files in `~/agent-leases/`) | `claim / release / renew / narrow / list / check [--skip-leased] / events`, and the deploy queue `deploy request / list / approve / cancel / start / finish / wait / record / last`. Exit codes 0 ok, 1 error, 3 busy, 4 deploy pending | Claims have no queue: a busy claim exits 3 and the agent polls; expiry is lazy; no heartbeat (TTL 120 min, manual renew); `--shared` has no semantics; the env string is not validated |
| The `deploy` skill | `~/.claude/skills/deploy/SKILL.md` on each machine | The rules agents follow; a 4-minute polling loop for up to 2 h when busy | Says a full or server deploy is blocked by *any* lease, which contradicts the CLI and `update_core.sh --skip-leased`; the rewrite of 2026-10-14 dropped the `--kind`, agent-name and "narrowest resource" sections that the scripts still refer to |
| `update_core.sh` | VirtualPyTest repo, `setup/proxmox/node/` | Checks the resources its flags touch, then claims them (two calls, not atomic); `--skip-leased` drops leased hosts and prints `SKIPPED_HOSTS=` | Deploys anyway when the registry is unreachable (fails open) |
| `leases.js`, `lease-watch.js`, `deploy-runner.js`, `public/platforms.js` | mycodebox | Read the registry over ssh (`list --json` every 15 s); lease-watch narrows idle `server` holds and releases holds of ended codebox sessions; the deploy runner auto-approves and starts queued deploys | Read-only views over ssh; three more copies of the blocking rules (`blockersOf`, `scopeTouches`); Mac holders (`mac:*`, 59 % of all leases) and free-form agent names are never reclaimed |
| `orchestration/lease-authority.js` | mycodebox V2 | Atomic, fenced (per-resource generation), fail-closed leases with audit, write-ahead ids and `acquireAll`; tests T25–T27 | In-process library with six V2-only resource namespaces; no queue, modes, hierarchy, network API or heartbeat policy |
| VPT device locks | the VPT server, read by `vpt-locks.js` | Take-control and script locks inside the product | A separate system; not covered here (see §9) |

Measured from `lease-events.jsonl` (575 events): resource shapes `<host>` 368, `frontend` 187, `*` 102, `<host>/<dev>` 79;
kinds `server` 408, `host` 167; agents `mac:` 338, `codebox:` 100, scripts 77, free-form 49; median hold 1.3 min, p90
10 min, max 138 min. Most leases are short; a few long `*` / `server` holds cause the waits.

The harness review ([HARNESS-REVIEW-2026-10-14](reviews/HARNESS-REVIEW-2026-10-14.md)) shows the cost: a 75-minute wait
on a lease that was free, a frontend change blocked 70 minutes by a backend lease that does not apply to it,
contradicting rules between sessions, sessions asking the owner about leases instead of checking, and leases held while
the holder only waited.

## 2. One authority

The mycodebox server is the single writer of every lease and of the deploy queue. `lease-service.js` runs inside the
server process:

- **Engine.** Lease records keep the semantics of `orchestration/lease-authority.js`: a lease id, a per-resource
  generation as the fencing token, identity-before-time checks, fail-closed errors (`E_UNAVAILABLE`, never "free"),
  a mandatory audit line before every grant. Because conflicts are hierarchical (an env-wide lease conflicts with every
  device), the store is one in-memory index behind one async mutex, persisted as an append-only journal
  (`<state>/leases/journal.jsonl`, `fsync` before the reply) plus a periodic atomic snapshot. One process, one writer:
  no cross-file locking is needed.
- **Reach.** HTTP on the existing server under `/api/lease/v1/`, reachable from codebox, the owner's Mac, the registry
  host and the device hosts over the tailnet (the same listener and Tailscale Serve setup as the dashboard). Never
  public: requests from outside loopback and the tailnet range (or `LEASE_ALLOW_CIDRS`) are refused before
  authentication.
- **Authentication.** A bearer token per client machine or script (`Authorization: Bearer ...`), stored hashed in
  `<state>/leases/clients.json` with its name. `node scripts/lease-token.js add <name>` prints a new token once;
  `revoke <name>` removes it. The caller's identity in every record is `<client name>` plus the agent string it sends.
  The dashboard itself calls the service in-process.
- **Client.** `vpt-lease` becomes a thin client (`scripts/vpt-lease`, Python 3 standard library only, so it runs on the
  registry host and the device hosts unchanged): the same subcommands, arguments, output lines and exit codes, plus the
  new options below. Scripts and skills keep working.

## 3. Typed resources and the conflict matrix

A resource is `<env>` plus one typed target. The legacy spellings stay valid and map as shown.

| Type | Spelling | Legacy | Means |
|---|---|---|---|
| env | `<env>/*` | `*` | everything in the env (use only for a full deploy or env-wide maintenance) |
| frontend | `<env>/frontend` | `frontend` | the web frontend build and its deploy |
| server | `<env>/server` | `server` | the backend services on the env's server (a server deploy or restart) |
| host | `<env>/host:<h>` | `<h>` | one device host: its services and every device on it (host deploy, host maintenance) |
| device | `<env>/device:<h>/<d>` | `<h>/<d>` | one device (a set-top box, a phone) |

Each lease also has a **mode** and, for exclusive leases, a **sensitivity**:

- `exclusive`: you drive or change it (remote keys, channel changes, deploys, restarts).
- `observe`: you read its archive, frames or logs. Never conflicts with anything; listed for visibility.
- `pin`: a soft request ("keep this channel / state until T"). Never blocks; shown to others and on the dashboard; when
  someone is granted an exclusive lease that overlaps a pin, the pin holder gets an event (and, for a codebox session, a
  one-line message).
- Sensitivity (`--kind`, legacy): `server` means a server restart breaks you (runs started through the server API, the
  UI, MCP, take-control); `host` means only a restart of your own host's services breaks you. Default: `host` for a
  device lease, `server` otherwise (as today).

**Conflict matrix** (a new exclusive claim vs a held exclusive lease of another agent; `observe` and `pin` never
conflict; the same agent never conflicts with itself):

| New claim \ held | env | frontend | server | host:h | device:h/d |
|---|---|---|---|---|---|
| env | X | X | X | X | X |
| frontend | X | X | - | - | - |
| server | X | - | X | sensitivity `server` only | sensitivity `server` only |
| host:h | X | - | - | same h | same h |
| device:h/d | X | - | - | same h | same h/d |

So a frontend deploy never waits for a device run or a backend lease, and a run on one device never blocks another
device on the same host.

**Deploys** claim their scope through the same matrix: `frontend` = frontend; `server` = server; `host` with `--hosts`
= those hosts; `full` = env-wide, except that leased hosts are skipped (the `--skip-leased` behaviour: a held host or
device lease drops that host from the deploy and queues a catch-up `host` deploy for it; only `env` and
`server`-sensitive leases block a full deploy). There is exactly one implementation of these rules, in
`lease-service.js`; the dashboard, the deploy runner and the client ask it instead of keeping copies.

## 4. Never ask, wait: the FIFO queue

- A claim that conflicts gets a **ticket** instead of an error when the client asks for one: `vpt-lease claim ...
  --wait` blocks until granted (it long-polls `GET /tickets/<id>?wait=30`), `--ticket` returns the ticket id and the
  estimate at once so the session continues other work and later runs `vpt-lease ticket <id> --wait`. Without either
  option the legacy behaviour holds: exit 3 when busy.
- Tickets are granted in FIFO order per conflict set: a ticket is granted when it conflicts with no held lease **and**
  with no earlier waiting ticket, so a stream of short claims cannot starve a waiting deploy.
- **ETA**: for each blocker, the later of now and its expected end (its own `expect_min` if the holder gave one, else
  the median hold of that resource type over the last 7 days, capped by its TTL); the ticket's ETA is the latest
  blocker end plus the expected holds of the tickets ahead of it. Every answer shows `position`, `eta` and the holders.
- A ticket expires when its client stops polling for 10 minutes (a session that went away does not keep a place).
- **The deploy queue** moves into the same service with the registry's semantics: `deploy request / list / approve /
  cancel / start / finish / wait / record / last`, FIFO per env, coalescing of same-ref requests, catch-up host deploys
  from `SKIPPED_HOSTS`, the "deployed now" ledger. The mycodebox deploy runner calls it in-process.
- **Nobody asks the owner about a lease.** The rule text (§7) says so, and the manager answers lease questions from the
  service ("<resource> is held by <agent> for <purpose>, you are #2, expected free at 14:20; wait with `vpt-lease claim
  ... --wait`") instead of escalating them.

## 5. No ghost holds

- **TTL plus heartbeat.** A lease has a TTL (default 120 min, cap 8 h; a longer one needs `--ttl` and is shown in
  amber) and a heartbeat interval (default 5 min). The client sends heartbeats while the command that holds the lease
  runs: `vpt-lease run <claim args> -- <command>` claims, runs the command, heartbeats in the background and releases
  when it exits (also on failure or interrupt). Interactive holders heartbeat with `vpt-lease heartbeat <id>
  [--active]`. A lease with no heartbeat for three intervals is released and logged.
- **Session liveness.** A lease records the holder's session (`codebox:<tmux>`, `mac:<id>`, a script name). For codebox
  sessions the dashboard knows which tmux sessions are alive: a gone session loses its leases after a 2-minute grace;
  session end releases them at once. Mac and other machines rely on the heartbeat (round 9's Mac hook can report
  liveness later).
- **Idle exclusive holds become pins** (addendum). An exclusive lease with no `--active` heartbeat (control activity on
  the resource) for `idleMs` (default 20 min, configurable per resource type) is downgraded to `pin` and the queue moves
  on; the holder is told. A codebox session whose last STATUS is `waiting` or `blocked` on its own job never keeps an
  exclusive lease: it is downgraded when that STATUS is seen. Copying archived chunks read-only needs `observe` or no
  lease at all.
- **Owner force-release** from the Leases view: one tap plus a second tap to confirm, logged with `by: owner`, the
  holder is told.

## 6. Visible

- A **Leases** view on the dashboard (More menu and `/?leases=1`): per env, each held lease with resource, mode,
  holder (session link when known), purpose, since, TTL left, last heartbeat, and the queue with position and ETA;
  owner actions: force-release, downgrade to pin.
- **Voice**: one spoken line in the voice digest and on request ("3 leases held; the frontend queue has 1 waiting, ETA
  2 minutes; no lease is idle").
- **Events**: grants, releases, expiries, downgrades and force-releases are journal events with a cursor
  (`GET /events?after=`), feeding the manager's events and lease-based handoffs as today.

## 7. One rule text

The rules live once, in `docs/LEASE-RULES.md` (what to claim for each kind of work, modes, waiting, heartbeats, what never
to do). `scripts/render-deploy-skill.js` renders that text into the lease section of the `deploy` skill; the owner side
copies the rendered skill to both machines. The manager enforces the same rules: it never escalates a lease question,
it answers it from the service, and it flags a session that holds an exclusive lease while its STATUS says it waits.
This folds in round 9 item 6 ("frontend-only deploys need no backend lease; busy means wait and retry, never ask").

## 8. Failure behaviour

- The service unreachable: `claim`, `check` and every `deploy` subcommand exit 5 (`UNAVAILABLE`); deploy paths treat it
  as busy, never as free. With `--wait` the client retries with backoff (5 s doubling to 2 min) and keeps waiting; it
  never asks the owner. `update_core.sh` must stop deploying without the check when the registry is unreachable (owner
  side change, listed in the cut-over).
- A corrupt or missing journal: the service starts read-only and refuses grants until the owner restores it
  (`E_UNAVAILABLE`), as `lease-authority.js` does today.

## 9. Not in this round

- VPT's in-product device locks (take-control, script locks) stay separate; the Leases view links to them. Unifying them
  is a later step.
- Remote session liveness for the Mac comes with round 9's Mac intake.

## 10. Shadow period, cut-over, rollback

The client has three modes, set per machine with `VPT_LEASE_MODE` (and `VPT_LEASE_URL`, `VPT_LEASE_TOKEN_FILE`):

| Mode | Authoritative | Also |
|---|---|---|
| `legacy` (default) | the old registry | nothing (today's behaviour) |
| `shadow` | the old registry | every command is also sent to the service with `shadow: true` (it keeps a separate shadow store and never grants anything real); the client compares the outcomes (exit code, busy or free, lease ids mapped) and posts each disagreement to `POST /shadow-report`; the Leases view shows them |
| `central` | the service | the old registry is not called |

Cut-over (owner side; nothing here is done by this round):
1. Merge, restart mycodebox, create one token per machine (`node scripts/lease-token.js add <name>`).
2. Install the client and its token on codebox, the Mac, the registry host and the device hosts; set
   `VPT_LEASE_MODE=shadow`.
3. Run a day in shadow; read the disagreement list on the Leases view; fix or explain each.
4. Set `VPT_LEASE_MODE=central` on every machine at once; the service imports the registry's open leases and queued
   deploys (`node scripts/lease-import.js`, reading `list --json` and `deploy list --json`).
5. Update `update_core.sh` (fail closed, one atomic claim instead of check-then-claim), render and copy the deploy skill.

Rollback: set `VPT_LEASE_MODE=legacy` everywhere; the old registry was never modified by the service and takes over
again (leases granted by the service in the meantime are listed by `node scripts/lease-export.js` for the owner).

## Appendix A. API contract (v1)

All routes are under `/api/lease/v1`, JSON in and out, `Authorization: Bearer <token>` (in-process callers skip HTTP).
Errors: `{ ok: false, code, error }` with `code` one of `E_INVALID` (400), `E_AUTH` (401/403), `E_HELD` (409, with
`holders`), `E_DEPLOY_PENDING` (409), `E_NOT_FOUND` (404), `E_FENCED` (409), `E_UNAVAILABLE` (503).

| Route | Body / query | Answer |
|---|---|---|
| `POST /claim` | `{ env, resources: [..], agent, session?, purpose?, mode: exclusive\|observe\|pin, kind?: server\|host, ttl_min?, heartbeat_s?, expect_min?, wait?: false\|"ticket", shared? }` | granted: `{ ok, lease: { id, env, resources, mode, kind, agent, session, purpose, since, expires_at, generation, heartbeat_s } }`; busy without wait: `E_HELD` + `holders` + `eta`; with `wait: "ticket"`: `{ ok, ticket: { id, position, eta, holders } }` |
| `GET /tickets/:id?wait=<s>` | long-poll up to 30 s | `{ ok, ticket: { id, state: waiting\|granted\|expired\|cancelled, position, eta, lease? } }` |
| `DELETE /tickets/:id` | | cancels a ticket |
| `POST /release` | `{ id }` or `{ agent }` (+ `by`, `reason`) | `{ ok, released: [ids] }` |
| `POST /renew` | `{ id, ttl_min? }` | `{ ok, lease }` |
| `POST /heartbeat` | `{ id, active?: bool }` | `{ ok, lease }` (`active` = control activity, resets the idle clock) |
| `POST /narrow` | `{ id, resources?, kind? }` | one-way narrowing, as `vpt-lease narrow` |
| `POST /mode` | `{ id, mode }` | downgrade only (exclusive -> pin/observe) by the holder; owner may do it for anyone |
| `GET /list?env=` | | `{ ok, leases: [...with ttlLeftMin, idleMin, lastHeartbeatAt], tickets: [...], deploys: [...] }` |
| `GET /check?env=&resources=a,b&ignore_agent=&skip_leased=1&hosts=` | | `{ ok, free: bool, holders, leased_hosts? }` (legacy `check` / `check --skip-leased`) |
| `GET /events?after=<n>&limit=` | | `{ ok, events: [{ n, at, kind: granted\|released\|expired\|downgraded\|forced\|narrowed\|ticket, ... }], next }` |
| `POST /owner/release` | `{ id, by: owner }` | force-release, logged |
| `POST /deploy/request` `/deploy/approve` `/deploy/cancel` `/deploy/start` `/deploy/finish` `/deploy/record` | the registry's arguments as JSON | the registry's answers as JSON |
| `GET /deploy/list`, `GET /deploy/wait?id=&env=&timeout=`, `GET /deploy/last?env=` | | as the registry |
| `POST /shadow-report` | `{ machine, command, legacy: { code, out }, central: { code, out } }` | stored for the Leases view |

The in-process module `lease-service.js` exports `createLeaseService({ dir, now, sessions, onEvent, config })` with the
same operations as methods (`claim, ticket, cancelTicket, release, renew, heartbeat, narrow, setMode, list, check, events,
ownerRelease, deploy: { request, approve, cancel, start, finish, record, list, wait, last }, shadow: { op, report, list },
sessionGone(session), sessionStatus(session, status), tick() })`, all async, all fail closed.

Client exit codes: 0 ok, 1 error / not found, 3 busy, 4 deploy pending, 5 unavailable.
