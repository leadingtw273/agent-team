# Agent Team systemd user units

`agent-team systemd install` renders these templates for the currently executing compiled CLI,
runs `systemd-analyze verify`, writes the two canonical unit files, reloads the user manager, and
enables `agent-team-reconcile.timer`.

The timer starts after boot and then five minutes after each short-lived reconcile run completes.
It invokes the semantic equivalent of `agent-team reconcile --all` using the exact Node executable
and compiled CLI entrypoint that passed the install preflight.

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

The rendered service and every preflight command receive the same allowlisted runtime environment:
`PATH`, `HOME`, `XDG_CONFIG_HOME`, and, when set, `XDG_RUNTIME_DIR` and `AGENT_TEAM_HOME`.
Other inherited variables, including credentials and tokens, are intentionally excluded.
`status` reports ownership plus `is-enabled`, `is-active`, and `is-failed` query results; command
or D-Bus errors are reported as unknown rather than as a disabled timer. It never enables,
disables, writes, or removes a unit.

Current activation is deliberately fail-closed: until Runtime composition wires
`agent-team reconcile --all`, install rejects the unavailable command and leaves no unit behind.
O008 reports that condition as a degraded wake-up path; this installer does not claim that a timer
has made the unwired Runtime autonomous.
