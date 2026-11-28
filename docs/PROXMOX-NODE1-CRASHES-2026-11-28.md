# Node1 hard stop 2026-11-28 (07:08Z to 08:43Z): findings

Read-only investigation, nothing rebooted or reset. Times UTC (host local is CET = UTC+1).
Rewritten the same day after an independent (Opus) review; the review's corrections are folded into the text below
(history: commits 3e7252f, c1746ba, 331ee74). **The list of every node1 crash and the running explanation live in the
crash register** of `~/virtualpytest/docs/agent/infra/PROXMOX_NODE_DOWN.md` on codebox (local, gitignored): read it first
next time; this file is the deep dive of row 14.

## Verdict (best evidence, not proof)

A **silent power loss of the whole machine** (confirmed: the owner found it off), **not the kernel and not a software shutdown**.
The hardware watchdog was armed and could not help: a box without power cannot be reset. Node1 is a bare-metal Ryzen 9 3900 on a B565D4-V1L board (BIOS L0.34, 2024-08), 128 GB
(4 x 32 GB ECC, 89 % used), AMD microcode loaded (`0x8701034`), `processor.max_cstate=1` in effect (only POLL and C1 exist).
The 7.0.14-26-pve kernel is **not** the cause: the same "crash" rows exist on 6.17.4 since January.

## Evidence

1. **Journal of the dead boot** (copied read-only through the NOPASSWD `cat` on the journal files; `journalctl --file`):
   last line `2026-11-28T07:07:02Z` (an sshd refusal); no panic, oops, MCE, hung-task, thermal, NVMe or OOM line in the whole boot
   (kernel level warning and above: no entries). Next boot: `journald: system.journal corrupted or uncleanly shut down`. pstore is empty.
   Death window 07:08:09Z to 07:09:27Z (vitals sample 07:08:01Z, ssh answered 07:08:09Z).
2. **Netconsole to node2** (set up 2026-10-29): it caught the clean reboots (2 x `Rebooting.`, 1 x `Powering off.`), but for the
   2026-11-28 stop the last kernel line is a routine audit message at uptime 587952 s (6.8 d), and for the 2026-11-17 stop
   (alive at 19:06:01Z) at 1146022 s (13.2 d) also a routine audit line. A panic or oops would have been sent. The two call
   traces netconsole holds are container cgroup OOM kills, unrelated.
3. **Lockup detection was already on and stayed silent.** `kernel.hardlockup_panic=1` plus all-CPU backtraces have been set since
   2026-10-29 (`/etc/sysctl.d/90-crash-capture.conf`), with `kernel.panic=10`. Neither stop produced a trace or a 10 s reboot:
   the kernel did not see a lockup.
4. **The hardware watchdog was armed and did not fire.** `watchdog-mux` (Proxmox HA, `pve-ha-lrm`/`pve-ha-crm` active) holds the
   SP5100 TCO watchdog (`state=active`, timeout 10 s) and held it during the dead boot. The box stayed down 95 min and the next
   boot reports `bootstatus=0`: either this watchdog cannot reset this board, or the whole chip froze or lost power.
5. **Vitals** (owner brief): load 2.6, no PSI, oom=0, MCE/thermal 0, 69 C up to 07:08:01Z. ECC is real data: `amd64_edac` is
   loaded, mc0 `ce_count=0`, `ue_count=0`. No warning before the stop.
6. **Not new, not kernel-bound** (`last -x` / wtmpdb): rows ending `crash` (no shutdown record) on 6.17.4: 2026-01-18, 02-16,
   03-16, 03-30, 04-02, 07-20, 08-25, 09-21, 10-10, 10-16, 10-25; on 7.0.14: 2026-11-17 and 2026-11-28. Interval shrank from months
   to 6 to 13 days since October. 6.17.13 (Oct 30 to Nov 4) ended clean. The owner brief's "Nov 4" row is the 7.0.14 boot that
   started Nov 4 and crashed Nov 17; Nov 4 itself was a clean reboot. Vitals gaps give uptimes of 3.2 d (Oct 28), 13.8 d (Nov 17),
   7.0 d (Nov 28), a different hour each time, with no vzdump / md check / scrub / VM start at the moment of death.
7. **Nov 21 00:36 to 08:37 CET was not a crash**: netconsole shows `systemd-shutdown: Powering off.` (a requested power off, 8 h down).
8. **Comparison host** (node2, Xeon E5-1650 v3, kernel 6.17.13): up 36 weeks without a crash. Different hardware, so it only
   shows the fleet kernel line is not broadly unstable.

## How it came back

At 08:43Z the owner found it **already powered off** in Hetzner Robot and started it, 95 min after the stop: nothing (watchdog, panic reboot, Hetzner) brought it back on its own.
On 2026-11-17 a Robot hardware reset did not revive it either; only a Hetzner cold power cycle did (register row 13).
So the machine lost power, and the OS did not ask for it: no shutdown record, no power-button event, the journal cut mid-run.
That also explains Nov 17 (a reset cannot revive a box with no power). Left: power supply, board power circuit or rack feed;
no BMC/IPMI log is exposed and the CPU reset-reason line is not logged on this Zen 2, so only Hetzner can say which.

## Proposal

- Keep the kernel; do not roll back 7.0.14 for this (no correlation; 6.17.4 stopped the same way). Optionally pin it so a later
  upgrade does not add a variable.
- Keep netconsole and the Oct 29 lockup sysctls.
- Do **not** add a systemd `RuntimeWatchdogSec`: it would race `watchdog-mux` for the device at boot and break HA fencing.

Owner-only items (credential, money, physical):
1. **Hetzner hardware ticket of 2026-11-17** ("Server - Not Stable", full CPU/RAM/PSU/board check, already sent): record the
   answer and test date in the register; if nothing was tested, chase it with rows 13 and 14. Ask for a BIOS newer than L0.34
   and Power Supply Idle Control = Typical Current Idle. A replacement or server swap is a money decision.
2. **Watchdog test**: with approval, in a deploy window, trigger the watchdog once on purpose to prove it can reset this board.

## Applied, then removed, 2026-11-28 (no reboot)

- `/etc/sysctl.d/90-crash-forensics.conf` (`kernel.softlockup_panic=1`; the other two lines were already in effect) was applied
  in the morning, then **deleted on the owner's go** and `softlockup_panic` set back to 0 live: with `kernel.panic=10` a soft
  lockup would have rebooted node1 and every VM on it, for little forensic gain (Evidence 3). `99-*.conf` already persists
  `softlockup_panic = 0`. Still on from Oct 29: `hardlockup_panic=1`, all-CPU backtraces, netconsole.
- A staged `/etc/systemd/system.conf.d/90-hw-watchdog.conf` (`RuntimeWatchdogSec=30`) was written, then removed the same day
  before any boot used it (see Proposal); the directory is empty now.
