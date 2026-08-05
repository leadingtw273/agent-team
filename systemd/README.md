# Agent Team systemd user units

`agent-team systemd install` renders these templates for the currently executing compiled CLI,
then runs `systemd-analyze verify`, writes only the two marker-owned unit files, reloads the user
manager, and enables `agent-team-reconcile.timer`.

The timer starts after boot and then five minutes after each short-lived reconcile run completes.
It invokes the semantic equivalent of `agent-team reconcile --all` using the exact Node executable
and compiled CLI entrypoint that passed the install preflight.

Use `agent-team systemd install --dry-run` (or `--preview`) to inspect the rendered unit contents
without writing files or running systemd commands. `uninstall` refuses mixed or non-agent-team
ownership and removes units only after it has identified both files as agent-team managed.
`status` reports the ownership state and runs the same deterministic Runtime preflight; it never
enables, disables, writes, or removes a unit.

Current activation is deliberately fail-closed: until Runtime composition wires
`agent-team reconcile --all`, install rejects the unavailable command and leaves no unit behind.
O008 reports that condition as a degraded wake-up path; this installer does not claim that a timer
has made the unwired Runtime autonomous.
