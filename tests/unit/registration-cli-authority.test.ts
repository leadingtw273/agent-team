import { describe, expect, it, vi } from "vitest";

import {
  buildRegistrationProbeAuthority,
  fixedRegistrationRevision,
  freshAuthorityDigest,
  freshRegistrationProbeRunId,
  resolveRegistrationProbeRunId,
} from "../../src/cli/registration/authority.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import type { RegistrationProbeJournalPort } from "../../src/application/registration/index.js";

describe("freshAuthorityDigest", () => {
  it("produces a valid, distinct 64-hex-char digest per call", () => {
    const first = freshAuthorityDigest();
    const second = freshAuthorityDigest();

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toBe(second);
  });
});

describe("freshRegistrationProbeRunId", () => {
  it("produces a valid, bounded probe-<hex> id that differs every call", () => {
    const first = freshRegistrationProbeRunId();
    const second = freshRegistrationProbeRunId();

    expect(first).toMatch(/^probe-[a-f0-9]+$/u);
    expect(first).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/u);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).not.toBe(second);
  });
});

describe("resolveRegistrationProbeRunId (F-1 fix)", () => {
  it("mints a genuinely fresh runId when this project has no active run, and a *different* one on every call", async () => {
    const listActiveForProject = vi.fn(() => Promise.resolve(ok([])));
    const journal = { listActiveForProject } as unknown as Pick<
      RegistrationProbeJournalPort,
      "listActiveForProject"
    >;

    const first = await resolveRegistrationProbeRunId(journal, "project-a" as never);
    const second = await resolveRegistrationProbeRunId(journal, "project-a" as never);

    expect(first.ok && first.value.resumed).toBe(false);
    expect(second.ok && second.value.resumed).toBe(false);
    expect(first.ok && second.ok && first.value.runId).not.toBe(second.ok && second.value.runId);
  });

  it("never returns a runId belonging to a terminal (verified/incomplete) journal entry -- listActiveForProject already excludes those", async () => {
    // isTerminalCleanPhase-filtered runs never appear in listActiveForProject's own result (that
    // is the O006 journal port's own contract) -- so an empty result here *is* "only terminal
    // entries exist, if any", and must always mint a fresh id, never replay one.
    const listActiveForProject = vi.fn(() => Promise.resolve(ok([])));
    const journal = { listActiveForProject } as unknown as Pick<
      RegistrationProbeJournalPort,
      "listActiveForProject"
    >;

    const resolved = await resolveRegistrationProbeRunId(
      journal,
      "project-with-old-verified-run" as never,
    );

    expect(resolved.ok && resolved.value.resumed).toBe(false);
    expect(resolved.ok && resolved.value.runId).not.toBe("probe-old-verified-run");
  });

  it("resumes the exact runId of an existing non-terminal (active) run instead of minting a new one", async () => {
    const listActiveForProject = vi.fn(() =>
      Promise.resolve(ok([{ runId: "probe-in-flight-run" }])),
    );
    const journal = { listActiveForProject } as unknown as Pick<
      RegistrationProbeJournalPort,
      "listActiveForProject"
    >;

    const resolved = await resolveRegistrationProbeRunId(journal, "project-a" as never);

    expect(resolved).toEqual(ok({ runId: "probe-in-flight-run", resumed: true }));
  });

  it("propagates a journal read failure rather than silently minting a runId", async () => {
    const listActiveForProject = vi.fn(() => Promise.resolve(err(domainError("unavailable"))));
    const journal = { listActiveForProject } as unknown as Pick<
      RegistrationProbeJournalPort,
      "listActiveForProject"
    >;

    const resolved = await resolveRegistrationProbeRunId(journal, "project-a" as never);

    expect(resolved).toEqual(err(domainError("unavailable")));
  });
});

describe("buildRegistrationProbeAuthority", () => {
  it("always uses user_conversation, per decision #2", () => {
    const authority = buildRegistrationProbeAuthority(
      "proj-1" as never,
      "setup-1",
      fixedRegistrationRevision,
    );

    expect(authority).toEqual({
      schemaVersion: 1,
      source: "user_conversation",
      projectId: "proj-1",
      setupSessionId: "setup-1",
      registrationRevision: fixedRegistrationRevision,
    });
  });
});
