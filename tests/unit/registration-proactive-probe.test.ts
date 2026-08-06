import { describe, expect, it } from "vitest";

import {
  createRegistrationProbeRun,
  registrationProbeBranch,
  registrationProbeMarker,
} from "../../src/application/registration/index.js";

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";
const revision = "a".repeat(40);

describe("registration proactive probe model", () => {
  it("derives bounded owned names and initializes every cleanup item fail closed", () => {
    const runId = "probe-018f47d2";
    const created = createRegistrationProbeRun({
      projectId,
      registrationRevision: 7,
      runId,
      worktreePath: `/tmp/agent-team-probes/${runId}`,
      activation: {
        setupSessionId: "setup-018f47d2",
        authoritativeRevision: revision,
        defaultBranch: "main",
        repository: "owner/sandbox",
        configDigest: "b".repeat(64),
      },
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(registrationProbeBranch(runId)).toBe(`agent-team/probe/${runId}`);
    expect(registrationProbeMarker(runId)).toBe(`agent-team-registration-probe:${runId}`);
    expect(created.value).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      phase: "reserved",
      projectId,
      registrationRevision: 7,
      runId,
      branch: `agent-team/probe/${runId}`,
      marker: `agent-team-registration-probe:${runId}`,
      cleanup: {
        linearIssue: { state: "pending", reason: "not_created" },
        draftPullRequest: { state: "pending", reason: "not_created" },
        remoteBranch: { state: "pending", reason: "not_created" },
        localWorktree: { state: "pending", reason: "not_created" },
      },
    });
  });

  it.each(["", "../escape", "contains/slash", "UPPER", "x".repeat(65)])(
    "rejects unsafe run id %j",
    (runId) => {
      expect(
        createRegistrationProbeRun({
          projectId,
          registrationRevision: 7,
          runId,
          worktreePath: "/tmp/agent-team-probes/rejected",
          activation: {
            setupSessionId: "setup-018f47d2",
            authoritativeRevision: revision,
            defaultBranch: "main",
            repository: "owner/sandbox",
            configDigest: "b".repeat(64),
          },
        }).ok,
      ).toBe(false);
    },
  );
});
