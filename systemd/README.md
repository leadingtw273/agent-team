# Agent Team systemd user units

`agent-team systemd install` renders these templates for the currently executing compiled CLI,
runs `systemd-analyze verify`, writes the two canonical unit files, reloads the user manager, and
enables `agent-team-reconcile.timer`.

The timer starts after boot and then five minutes after each short-lived Controller cycle completes.
It invokes the semantic equivalent of `agent-team cycle --all` using the exact Node executable
and compiled CLI entrypoint that passed the zero-side-effect install preview.
It is the fallback for a missing or failed Webhook wake-up, not a second scheduler: Webhook Runtime
and this timer enter the same short-lived, singleton Controller cycle.

Use `agent-team systemd install --dry-run` (or `--preview`) to inspect the rendered unit contents
without writing files or running systemd commands. Ownership is the complete canonical bytes of
both rendered units, not the public comment marker. A missing, mixed, drifted, symlinked, or
hard-linked unit is untrusted: install will not overwrite it and uninstall will not disable or
delete either file. The installer also rejects a symlink or non-directory in every component of
`$XDG_CONFIG_HOME/systemd/user`.

Uninstall disables the timer first, verifies that both canonical file identities are unchanged,
then atomically renames both files into randomized names in the same directory. It validates each
quarantined file again before deletion. Any failure restores or preserves the pair and reports a
rollback failure instead of claiming success.

File identity includes device, inode, link count, nanosecond ctime and birth time, owner, group,
mode, size, and nanosecond mtime in addition to canonical bytes. A same-byte replacement is still
untrusted. Because a successful rename can legitimately update ctime, quarantine captures a new
complete identity immediately after proving the remaining generation fields are unchanged; every
later pre-delete check uses that new complete identity.

The service does not use `Environment=` as an allowlist. Its `ExecStart` is an exact absolute
`/usr/bin/env -i` command: `-i` is followed by `PATH`, `HOME`,
`XDG_CONFIG_HOME`, and, when set, `XDG_RUNTIME_DIR` and `AGENT_TEAM_HOME`, then the absolute Node
and compiled CLI paths followed by only `cycle --all`. The install preflight is the rendered exact
command check; it never starts a cycle or dispatches work. Every argument uses systemd `ExecStart`
escaping.

Install re-reads both canonical identities and contents after `daemon-reload` and again after
`enable --now`. A replacement before enable blocks without enabling; a replacement during enable
causes a best-effort stop of the known timer name but is never deleted. Existing canonical units
must report either enabled/active (idempotent success) or disabled/inactive (eligible to enable);
unknown or inconsistent states block. Uninstall reports success only after the post-removal reload
and a read-back proving that both unit paths remain absent.

`status` reports ownership plus `is-enabled`, `is-active`, and `is-failed` query results; command
or D-Bus errors are reported as unknown rather than as a disabled timer. It never enables,
disables, writes, or removes a unit.

On Linux and WSL, each bounded management command runs as a detached POSIX process group. A
deadline sends `SIGTERM` to the whole group, waits a bounded grace period, then sends `SIGKILL` to
the whole group and waits for the direct child to settle. Output remains capped. Platforms without
POSIX process-group termination fail closed before spawning a command.

Install preflights the exact rendered command without running it. An exactly byte-identical v1
`reconcile --all` pair is recognized as owned legacy state and upgraded transactionally; a mixed,
drifted, or foreign pair is never overwritten. `agent-team health` and
`agent-team project` use the same manager's explicit read-only Runtime capability attestation,
canonical ownership, and timer read-back: a canonical enabled/active timer is reported as scheduled
reconcile availability, while missing, inactive, failed, untrusted, or indeterminate observations
remain unavailable or unknown. Their read-only projection never spawns a Controller cycle.
Webhook Runtime is not inferred from a timer. Until its own authoritative reader exists, an active
timer therefore reports the degraded `scheduled_reconcile_only` mode—not `unattended`—with the
fixed `webhook_runtime_unknown` and `manual_reconcile_required` evidence. When health reports a
partial or missing wake-up path, an operator may run `agent-team cycle --all` manually. That
command is the same Controller entrypoint as the timer and reports completed, degraded, failed, or
unwired Runtime status rather than manufacturing success.
