/**
 * O009 acceptance-critical unit tests for `registration setup *` handlers:
 * - a wrong stdin confirmation phrase is exit-2 ("rejected") with zero calls to the composition
 *   builder at all (proven with a fake counter, not just by inspecting the returned message).
 * - a composition that cannot reach "ready" maps to "blocked" (exit 3) with a fixed reason.
 */
import { describe, expect, it, vi } from "vitest";

import { createRegistrationSetupHandlers } from "../../src/cli/registration/setup-handlers.js";
import type { buildRegistrationSetupComposition } from "../../src/cli/registration/setup-composition.js";

async function* stream(chunk: string): AsyncIterable<string> {
  await Promise.resolve();
  yield chunk;
}

function neverCalledBuildComposition() {
  return vi.fn<typeof buildRegistrationSetupComposition>(() =>
    Promise.reject(new Error("must never be called: confirmation should reject first")),
  );
}

describe("registration setup start/approve: confirmation gate", () => {
  it("rejects a wrong setup start confirmation phrase with zero composition calls", async () => {
    const buildComposition = neverCalledBuildComposition();
    const handlers = createRegistrationSetupHandlers({
      agentTeamHome: "/nonexistent",
      stdin: stream("CREATE SETUP DRAFT P\n"), // truncated typo
      buildComposition,
    });

    const result = await handlers.setupStart({ projectId: "proj-1" });

    expect(result.state).toBe("rejected");
    expect(buildComposition).not.toHaveBeenCalled();
  });

  it("rejects a wrong setup approve confirmation phrase with zero composition calls", async () => {
    const buildComposition = neverCalledBuildComposition();
    const handlers = createRegistrationSetupHandlers({
      agentTeamHome: "/nonexistent",
      stdin: stream("approve setup merge\n"), // wrong case
      buildComposition,
    });

    const result = await handlers.setupApprove({ projectId: "proj-1" });

    expect(result.state).toBe("rejected");
    expect(buildComposition).not.toHaveBeenCalled();
  });

  it("accepts the exact setup start confirmation phrase and proceeds to build the composition", async () => {
    const buildComposition = vi.fn<typeof buildRegistrationSetupComposition>(() =>
      Promise.resolve({ state: "blocked", reason: "draft_unavailable" }),
    );
    const handlers = createRegistrationSetupHandlers({
      agentTeamHome: "/nonexistent",
      stdin: stream("CREATE SETUP DRAFT PR\n"),
      buildComposition,
    });

    const result = await handlers.setupStart({ projectId: "proj-1" });

    expect(buildComposition).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("blocked");
  });
});

describe("registration setup status/resume: fail-closed on missing configuration", () => {
  it("reports blocked (exit 3) with a fixed reason when the composition is not ready", async () => {
    const buildComposition = vi.fn<typeof buildRegistrationSetupComposition>(() =>
      Promise.resolve({ state: "blocked", reason: "linear_api_key_missing" }),
    );
    const handlers = createRegistrationSetupHandlers({
      agentTeamHome: "/nonexistent",
      buildComposition,
    });

    const status = await handlers.setupStatus({ projectId: "proj-1" });
    const resume = await handlers.setupResume({ projectId: "proj-1" });

    expect(status.state).toBe("blocked");
    expect(JSON.parse(status.message ?? "")).toMatchObject({ reason: "linear_api_key_missing" });
    expect(resume.state).toBe("blocked");
    expect(JSON.parse(resume.message ?? "")).toMatchObject({ reason: "linear_api_key_missing" });
  });

  it("reports the controller's read model on success", async () => {
    const readModel = Object.freeze({
      state: "preview_ready" as const,
      evidence: [],
      nextStep: "confirm",
      preview: {
        setupSessionId: "setup-1",
        projectId: "proj-1",
        projectName: "Sandbox",
        repository: "owner/sandbox",
        defaultBranch: "main",
        baseRevision: "a".repeat(40),
        previewDigest: "b".repeat(64),
        requirementsDigest: "c".repeat(64),
        linearAuditIssueId: "LINEAR-AUDIT-1",
      },
    });
    const buildComposition = vi.fn<typeof buildRegistrationSetupComposition>(() =>
      Promise.resolve({
        state: "ready",
        composition: {
          controller: { read: vi.fn(() => Promise.resolve(readModel)) },
          wiring: {
            state: "ready",
            durableState: "w1_file_stores",
            mergedConfigReadBack: "w2_github_authoritative",
            merge: "w3b2_controller_squash",
            audit: "w3b1_receipts",
            conversationApproval: "unwired",
            activation: "w3b2_project_index",
          },
        },
      } as never),
    );
    const handlers = createRegistrationSetupHandlers({
      agentTeamHome: "/nonexistent",
      buildComposition,
    });

    const status = await handlers.setupStatus({ projectId: "proj-1" });

    expect(status.state).toBe("success");
    expect(JSON.parse(status.message ?? "")).toMatchObject({
      operation: "registration_setup_status",
      state: "preview_ready",
    });
  });
});
