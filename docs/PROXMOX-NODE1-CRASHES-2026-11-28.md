# Node1 hard stop 2026-11-28 (07:07Z to 08:43Z): findings

Read-only investigation, nothing rebooted or reset. Times UTC (host local is CET = UTC+1).

## Verdict (best evidence, not proof)

A **silent hard stop of the machine** (power / hardware reset / CPU hang), **not the kernel and not a software shutdown**. Node1 is a
bare-metal Ryzen 9 3900 on a B565D4-V1L board (BIOS L0.34, 2024-08), microcode updates blacklisted, `processor.max_cstate=1` already set.
The 7.0.14-26-pve kernel is **not** the cause: the same "crash" rows exist on 6.17.4 since January.

## Evidence

1. **Journal of the dead boot** (copied read-only through the NOPASSWD `cat` on the journal files; `journalctl --file`):
   last line `2026-11-28T07:07:02Z` (a sshd refusal); no panic, oops, MCE, hung-task, thermal, NVMe or OOM line in the whole boot
   (kernel level warning and above: no entries). Next boot: `journald: system.journal corrupted or uncleanly shut down`. pstore is empty.
2. **Netconsole to node2** (set up 2026-10-29): it caught the clean reboots (2 x `Rebooting.`, 1 x `Powering off.`) but for the crash of
   the boot that ran to 2026-11-28 the last kernel line is a routine audit message at uptime 587952 s (6.8 d), and for the boot that
   ended on 2026-11-17 at 1146022 s (13.2 d) also a routine audit line. A panic or oops would have been sent: it is a hang or a reset
   below the kernel (netconsole cannot tell power loss from a CPU lockup).
3. **Vitals** (owner brief): load 2.6, no PSI, oom=0, ecc/MCE/THR 0, 69 C up to 07:08:01Z. No warning before the stop.
4. **Not new, not kernel-bound** (`last -x` / wtmpdb): rows ending `crash` (no shutdown record) on 6.17.4: 2026-01-18, 02-16, 03-16,
   03-30, 04-02, 07-20, 08-25, 09-21, 10-10, 10-16, 10-25; on 7.0.14: 2026-11-17 (journal ends 19:05:52Z) and 2026-11-28. Interval
   shrank from months to 6 to 13 days since October. 6.17.13 (Oct 30 to Nov 4) ended clean.
   The owner brief's "Nov 4" row is the 7.0.14 boot that started Nov 4 and crashed Nov 17; Nov 4 itself was a clean reboot.
5. **Nov 21 00:36 to 08:37 CET** was not a crash: netconsole shows `systemd-shutdown: Powering off.` (a requested power off, 8 h down).
6. **Comparison host** (node2, Xeon E5-1650 v3, kernel 6.17.13): up 36 weeks without a crash. Different hardware, so it only
   shows the fleet kernel line is not broadly unstable.
7. Not the in-guest software: the node watchdog script only restarts services; `panic=10` would turn a panic into a reboot with a
   netconsole trace; the hardware watchdog (sp5100-tco) is present but not armed by anything that would fire at 07:07.

## Not obtainable here

The Hetzner Robot reset/rescue log (who or what triggered the 08:43Z boot, any "hardware reset" ticket) needs Robot credentials,
which no file on codebox holds. Whether 08:43Z was a Robot reset or a power cycle is therefore unconfirmed. Node1's journal
cannot say either (BIOS reset cause is not logged).

## Proposal

Additive, safe (can be applied by the manager, none applied here):
- Keep the kernel; do not roll back 7.0.14 for this (no correlation; 6.17.4 crashed the same way). Optionally pin it so a later
  upgrade does not add a variable.
- Arm the SP5100 hardware watchdog (`RuntimeWatchdogSec=30` in systemd `system.conf`) so a CPU hang becomes an automatic reset in
  30 s instead of waiting for someone; this does not fix the cause. (A reboot-level change: a deploy-window decision.)
- Keep netconsole; add `kernel.softlockup_panic=1`, `kernel.hardlockup_panic=1`, `kernel.nmi_watchdog=1` so a lockup panics and
  shows on netconsole; if still silent, it is power or hardware.
- Run `memtest` is not possible without the owner (rescue / reboot).

Owner-floor items (money, credential, physical):
1. **Hetzner Robot**: read the reset / rescue log for 2026-11-17 19:3xZ and 2026-11-28 08:4xZ (credential only the owner holds).
2. **Hetzner hardware ticket** asking for a hardware check of node1 (RAM, PSU, board), citing >10 unexplained hard stops since January
   and the shrinking interval. A replacement or server swap would be a money decision.
3. **BIOS**: the board has L0.34 (2024-08); ask Hetzner if a newer BIOS exists; re-enable AMD microcode (currently blacklisted by
   the install default) is a reboot-level change; the Ryzen 3000 idle-hang class matches a quiet hang with `max_cstate=1` only partly.
