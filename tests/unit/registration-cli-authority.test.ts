import { describe, expect, it } from "vitest";

import {
  buildRegistrationProbeAuthority,
  deterministicRegistrationProbeRunId,
  fixedRegistrationRevision,
  freshAuthorityDigest,
} from "../../src/cli/registration/authority.js";

describe("freshAuthorityDigest", () => {
  it("produces a valid, distinct 64-hex-char digest per call", () => {
    const first = freshAuthorityDigest();
    const second = freshAuthorityDigest();

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toBe(second);
  });
});

describe("deterministicRegistrationProbeRunId", () => {
  it("is stable for the same project/revision so a re-run naturally resumes it", () => {
    const first = deterministicRegistrationProbeRunId("project-a", 1);
    const second = deterministicRegistrationProbeRunId("project-a", 1);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/u);
  });

  it("differs across distinct projects or revisions", () => {
    const a = deterministicRegistrationProbeRunId("project-a", 1);
    const b = deterministicRegistrationProbeRunId("project-b", 1);
    const c = deterministicRegistrationProbeRunId("project-a", 2);

    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
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
