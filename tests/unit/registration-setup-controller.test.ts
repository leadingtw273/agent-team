import { describe, expect, it } from "vitest";

import {
  RegistrationSetupController,
  registrationSetupBranchFor,
  type RegistrationSetupControllerPorts,
  type RegistrationSetupOutcome,
  type RegistrationSetupSession,
} from "../../src/application/registration/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import { domainError, err, ok, parseInstant } from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import { sha256Digest, type Sha256Digest } from "../../src/domain/review/index.js";

const authorityDigest = "a".repeat(64);
const project = projectSchema.parse({
  schemaVersion: 1 as const,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Sandbox",
  localRepositoryPath: "/tmp/agent-team-sandbox",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace-1", projectId: "team-1" },
  sourceControl: { provider: "github", repository: "owner/sandbox" },
});
const config = trustedProjectConfigSchema.parse({
  schemaVersion: 1 as const,
  projectId: project.id,
  defaultBranch: project.defaultBranch,
  platforms: {
    workManagement: project.workManagement,
    sourceControl: project.sourceControl,
  },
  projectRules: ["Run tests."],
  roleInstructions: { implementer: ["Stay in scope."] },
  commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
});
const headSha = "b".repeat(40);

function fixture(
  options: { source?: "ready" | "missing"; refreshed?: RegistrationSetupOutcome } = {},
) {
  const calls: unknown[] = [];
  const sessions = new Map<string, RegistrationSetupSession>();
  const ports: RegistrationSetupControllerPorts = {
    stateRoot: "/tmp/agent-team-state",
    ...(options.source === "missing"
      ? {}
      : {
          draftSource: {
            load: () =>
              Promise.resolve(ok({ project, config, linearAuditIssueId: "LINEAR-AUDIT-1" })),
          },
        }),
    git: {
      inspectRepository: () =>
        Promise.resolve(
          ok({ rootPath: project.localRepositoryPath, headSha, branch: "main", clean: true }),
        ),
    },
    coordinator: {
      begin: (request) => {
        calls.push(["begin", request]);
        return Promise.resolve({ state: "blocked", reason: "not_found" });
      },
      refresh: (request) => {
        calls.push(["refresh", request]);
        return Promise.resolve(
          options.refreshed ?? ({ state: "blocked", reason: "not_found" } as const),
        );
      },
    },
    approveAndMerge: (request, authority) => {
      calls.push(["merge", request, authority]);
      return Promise.resolve({ state: "blocked", reason: "not_found" });
    },
    resume: (request) => {
      calls.push(["resume", request]);
      return Promise.resolve({ state: "blocked", reason: "not_found" });
    },
    sessions: {
      load: (setupSessionId) => Promise.resolve(ok(sessions.get(setupSessionId))),
    },
    previewConfirmation: {
      issue: (binding, digest, mutation) => {
        calls.push(["preview-issue", binding, digest, mutation]);
        return Promise.resolve(
          ok({
            state: "issued" as const,
            grant: {
              confirmation: {
                source: "local_ui" as const,
                explicit: true as const,
                tokenId: "preview-token-1",
                ...binding,
              },
              expiresAt: "2026-08-06T12:05:00.000Z",
            },
          }),
        );
      },
      verify: () => Promise.resolve(ok({ state: "verified" as const })),
    },
    finalApproval: {
      issue: (binding, digest, mutation) => {
        calls.push(["approval-issue", binding, digest, mutation]);
        return Promise.resolve(
          ok({
            state: "issued" as const,
            grant: { approvalId: "approval-1", expiresAt: "2026-08-06T12:05:00.000Z" },
          }),
        );
      },
      verifyAndConsume: () => Promise.resolve(ok({ state: "rejected" as const })),
      readConsumed: () => Promise.resolve(ok(undefined)),
    },
  };
  return {
    controller: new RegistrationSetupController(ports),
    ports,
    calls,
    sessions,
  };
}

function digest(value: string): Sha256Digest {
  const parsed = sha256Digest(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function callName(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const items: unknown[] = value;
  return items[0];
}

function readySession(
  setupSessionId: string,
  previewDigest: Sha256Digest,
): RegistrationSetupSession {
  const requirementsDigest = digest("requirements");
  const diffDigest = digest("diff");
  const session: RegistrationSetupSession = {
    schemaVersion: 1,
    revision: 3,
    phase: "awaiting_user_approval",
    setupSessionId,
    project,
    config,
    baseRevision: headSha,
    worktree: {
      repositoryRoot: project.localRepositoryPath,
      path: `/tmp/agent-team-state/registration-setup/worktrees/${setupSessionId}`,
      branch: registrationSetupBranchFor(setupSessionId),
      headSha: "e".repeat(40),
    },
    remote: "origin",
    previewDigest,
    requirementsDigest,
    diffDigest,
    configDigest: digest("config"),
    headSha: "e".repeat(40),
    changeRequest: {
      id: "PR_node_1",
      number: 42,
      url: "https://github.test/owner/sandbox/pull/42",
      state: "open" as const,
      draft: false,
      baseBranch: "main",
      headBranch: registrationSetupBranchFor(setupSessionId),
      headSha: "e".repeat(40),
      mergeability: "mergeable",
      autoMergeEnabled: false,
      updatedAt: instant("2026-08-06T12:00:00.000Z"),
    },
    linearAuditIssueId: "LINEAR-AUDIT-1",
    gateEvidenceReceipt: {
      schemaVersion: 1,
      source: "source_control",
      projectId: project.id,
      repository: project.sourceControl.repository,
      changeRequestId: "PR_node_1",
      headSha: "e".repeat(40),
      requirementsDigest,
      diffDigest,
      ciChecksDigest: digest("checks"),
      reviewContext: "agent-team/review",
      reviewEvidenceUrl: "https://review.test/evidence",
      evidenceDigest: digest("gate"),
    },
    evidence: Object.freeze([
      {
        code: "setup_ci_passed",
        projectId: project.id,
        setupSessionId,
        previewDigest,
        requirementsDigest,
        headSha: "e".repeat(40),
      },
      {
        code: "setup_fresh_review_passed",
        projectId: project.id,
        setupSessionId,
        previewDigest,
        requirementsDigest,
        headSha: "e".repeat(40),
        diffDigest,
        changeRequestId: "PR_node_1",
      },
    ]),
  };
  return Object.freeze(session);
}

describe("W3A Registration Setup production controller", () => {
  it("derives preview from server draft + authoritative clean default-branch LocalGit", async () => {
    const { controller } = fixture();
    const result = await controller.read({ authorityDigest });
    expect(result).toMatchObject({
      state: "preview_ready",
      preview: {
        projectId: project.id,
        repository: project.sourceControl.repository,
        baseRevision: headSha,
      },
    });
    expect(result.preview?.setupSessionId).toMatch(/^setup-[0-9a-f]{64}$/u);
    expect(result.evidence.map((item) => item.code)).toEqual([
      "controller_only_squash_merge",
      "activation_index_required",
    ]);
    expect(controller).not.toHaveProperty("ports");
    expect(controller).not.toHaveProperty("approveAndMerge");
  });

  it.each(["authority", "nonce"] as const)(
    "fails closed on GET when an activated session has a mismatched %s binding",
    async () => {
      const initial = fixture();
      const model = await initial.controller.read({ authorityDigest });
      if (model.preview === undefined) throw new Error("missing preview");
      const session = {
        ...readySession(model.preview.setupSessionId, model.preview.previewDigest as Sha256Digest),
        phase: "activated" as const,
      };
      const test = fixture({
        refreshed: Object.freeze({
          state: "failed" as const,
          stage: "activation" as const,
          error: domainError("external_failure"),
          session,
        }),
      });
      test.sessions.set(session.setupSessionId, session);
      const read = await test.controller.read({ authorityDigest });
      expect(read.state).toBe("configuration_incomplete");
      expect(read.evidence.map((item) => item.code)).toContain("activation_index_required");
      expect(test.calls.map(callName)).toEqual(["refresh"]);
    },
  );

  it("renders an activated session with a missing project index as resumable", async () => {
    const initial = fixture();
    const model = await initial.controller.read({ authorityDigest });
    if (model.preview === undefined) throw new Error("missing preview");
    const session = {
      ...readySession(model.preview.setupSessionId, model.preview.previewDigest as Sha256Digest),
      phase: "activated" as const,
    };
    const test = fixture({
      refreshed: Object.freeze({ state: "merge_pending" as const, session }),
    });
    test.sessions.set(session.setupSessionId, session);

    await expect(test.controller.read({ authorityDigest })).resolves.toMatchObject({
      state: "merge_pending",
      session: { phase: "activated", setupSessionId: session.setupSessionId },
    });
    expect(test.calls.map(callName)).toEqual(["refresh"]);
  });

  it("fails closed when the server-side source is missing", async () => {
    const { controller, calls } = fixture({ source: "missing" });
    const result = await controller.read({ authorityDigest });
    expect(result.state).toBe("configuration_incomplete");
    expect(result.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "draft_source_unwired" })]),
    );
    expect(calls).toEqual([]);
  });

  it.each([undefined, "bad issue id with spaces"])(
    "fails closed with zero mutation for server-owned linearAuditIssueId=%s",
    async (linearAuditIssueId) => {
      const test = fixture();
      let repositoryReads = 0;
      const controller = new RegistrationSetupController({
        ...test.ports,
        draftSource: {
          load: () => Promise.resolve(ok({ project, config, linearAuditIssueId } as never)),
        },
        git: {
          inspectRepository: () => {
            repositoryReads += 1;
            return test.ports.git.inspectRepository({ rootPath: project.localRepositoryPath });
          },
        },
      });
      const read = await controller.read({ authorityDigest });
      expect(read.state).toBe("configuration_incomplete");
      expect(read.evidence.some((item) => item.code === "linear_audit_issue_invalid")).toBe(true);
      await expect(
        controller.refresh(
          { setupSessionId: "setup-invalid", idempotencyKeyPrefix: "invalid:refresh" },
          { authorityDigest },
        ),
      ).resolves.toMatchObject({ state: "configuration_incomplete" });
      expect(repositoryReads).toBe(0);
      expect(test.calls).toEqual([]);
    },
  );

  it("binds preview confirmation and start to trusted session + current digest", async () => {
    const { controller, calls } = fixture();
    const model = await controller.read({ authorityDigest });
    if (model.preview === undefined) throw new Error("missing preview");
    const issued = await controller.confirmPreview(
      {
        setupSessionId: model.preview.setupSessionId,
        previewDigest: model.preview.previewDigest,
        confirmation: "CREATE SETUP DRAFT PR",
        idempotencyKey: "controller:preview:issue",
      },
      { authorityDigest },
    );
    expect(issued).toMatchObject({ state: "preview_confirmation_issued" });
    if (issued.state !== "preview_confirmation_issued") return;
    await controller.start(
      {
        setupSessionId: issued.setupSessionId,
        previewDigest: issued.previewDigest,
        tokenId: issued.tokenId,
        idempotencyKeyPrefix: "controller:start",
      },
      { authorityDigest },
    );
    expect(calls).toHaveLength(2);
    expect(callName(calls[0])).toBe("preview-issue");
    const begin = calls[1];
    if (!Array.isArray(begin)) throw new Error("missing begin call");
    const beginItems: unknown[] = begin;
    expect(beginItems[0]).toBe("begin");
    expect(beginItems[1]).toMatchObject({
      trustedAuthority: { authorityDigest },
      confirmation: { tokenId: "preview-token-1" },
    });
  });

  it("derives the resume target only from the server-owned draft", async () => {
    const test = fixture();
    const model = await test.controller.read({ authorityDigest });
    if (model.preview === undefined) throw new Error("missing preview");
    await test.controller.resume(
      { idempotencyKeyPrefix: "controller:resume" },
      { authorityDigest },
    );
    expect(test.calls).toEqual([
      [
        "resume",
        {
          setupSessionId: model.preview.setupSessionId,
          idempotencyKeyPrefix: "controller:resume",
        },
      ],
    ]);
  });

  it("rejects non-exact confirmation phrases before issuing either durable intent", async () => {
    const test = fixture();
    const model = await test.controller.read({ authorityDigest });
    if (model.preview === undefined) throw new Error("missing preview");
    const preview = await test.controller.confirmPreview(
      {
        setupSessionId: model.preview.setupSessionId,
        previewDigest: model.preview.previewDigest,
        confirmation: "create setup draft pr",
        idempotencyKey: "controller:preview:wrong-phrase",
      },
      { authorityDigest },
    );
    const approval = await test.controller.issueLocalUiApprovalIntent(
      {
        setupSessionId: model.preview.setupSessionId,
        expectedSetupRevision: 3,
        confirmation: "approve setup merge",
        idempotencyKey: "controller:approval:wrong-phrase",
        idempotencyKeyPrefix: "controller:approval:wrong-phrase:refresh",
      },
      { authorityDigest },
    );
    expect(preview).toMatchObject({ state: "configuration_incomplete" });
    expect(approval).toMatchObject({ state: "configuration_incomplete" });
    expect(test.calls).toEqual([]);
  });

  it("issues a local-UI approval intent after refreshed immutable gates without merging", async () => {
    const initial = fixture();
    const model = await initial.controller.read({ authorityDigest });
    if (model.preview === undefined) throw new Error("missing preview");
    expect(model.preview.previewDigest).toMatch(/^[0-9a-f]{64}$/u);
    const session = readySession(
      model.preview.setupSessionId,
      model.preview.previewDigest as Sha256Digest,
    );
    const test = fixture({
      refreshed: Object.freeze({
        state: "awaiting_user_approval",
        session,
      }),
    });
    const result = await test.controller.issueLocalUiApprovalIntent(
      {
        setupSessionId: session.setupSessionId,
        expectedSetupRevision: session.revision,
        confirmation: "APPROVE SETUP MERGE",
        idempotencyKey: "controller:approval:issue",
        idempotencyKeyPrefix: "controller:approval:refresh",
      },
      { authorityDigest },
    );
    expect(result).toMatchObject({
      state: "approval_intent_issued",
      approvalId: "approval-1",
      mergeState: "configuration_incomplete",
    });
    expect(test.calls.map(callName)).toEqual(["refresh", "approval-issue"]);
  });

  it("does not convert unavailable draft reads into a preview", async () => {
    const test = fixture();
    const controller = new RegistrationSetupController({
      ...test.ports,
      draftSource: { load: () => Promise.resolve(err(domainError("unavailable"))) },
    });
    const result = await controller.read({ authorityDigest });
    expect(result.state).toBe("configuration_incomplete");
    expect(result.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "draft_source_unavailable" })]),
    );
  });
});
