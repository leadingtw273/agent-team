import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  RegistrationSetupApprovalBinding,
  RegistrationSetupConversationApprovalBridgePort,
  RegistrationSetupConversationHostCapability,
  RegistrationSetupGateEvidenceCommand,
} from "../../src/application/registration/index.js";
import {
  FileRegistrationSetupFinalApprovalAuthority,
  RegistrationSetupAuditAdapter,
  SourceControlRegistrationSetupGateEvidence,
  type LinearAuditCommentWriter,
  type PullRequestAuditCommentWriter,
  type RegistrationSetupExternalAuditCommentReceipt,
} from "../../src/adapters/registration/index.js";
import type {
  CommitChecksSnapshot,
  CommitStatusesSnapshot,
} from "../../src/application/ports/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";
import { projectSchema } from "../../src/domain/project/index.js";
import { sha256Digest } from "../../src/domain/review/index.js";

const headSha = "a".repeat(40);
const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Audit contract",
  localRepositoryPath: "/tmp/audit-contract",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});

function digest(value: string) {
  const result = sha256Digest(value);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

const requirementsDigest = digest("requirements");
const diffDigest = digest("diff");
const command: RegistrationSetupGateEvidenceCommand = Object.freeze({
  project,
  changeRequestId: "PR_node_1",
  expectedHeadSha: headSha,
  requirementsDigest,
  diffDigest,
});

function checks(overrides: Partial<CommitChecksSnapshot> = {}): CommitChecksSnapshot {
  return {
    headSha,
    aggregate: "success",
    checks: [{ name: "quality", status: "completed", conclusion: "success" }],
    ...overrides,
  };
}

function statuses(overrides: Partial<CommitStatusesSnapshot> = {}): CommitStatusesSnapshot {
  return {
    headSha,
    statuses: [
      {
        context: "agent-team/review",
        state: "success",
        targetUrl: "https://review.test/evidence/1",
      },
    ],
    ...overrides,
  };
}

function evidenceAdapter(ci = checks(), review = statuses()) {
  return new SourceControlRegistrationSetupGateEvidence({
    getCommitChecks: () => Promise.resolve(ok(ci)),
    getCommitStatuses: () => Promise.resolve(ok(review)),
  });
}

describe("Registration Setup exact-head gate evidence", () => {
  it("returns a typed receipt bound to project/PR/head/requirements/diff", async () => {
    const result = await evidenceAdapter().read(command);
    expect(result).toMatchObject({
      ok: true,
      value: {
        state: "ready",
        receipt: {
          source: "source_control",
          projectId: project.id,
          repository: project.sourceControl.repository,
          changeRequestId: command.changeRequestId,
          headSha,
          requirementsDigest,
          diffDigest,
          reviewContext: "agent-team/review",
          reviewEvidenceUrl: "https://review.test/evidence/1",
        },
      },
    });
  });

  it.each([
    ["empty checks", checks({ checks: [] }), statuses(), "ci_failed"],
    ["CI pending", checks({ aggregate: "pending" }), statuses(), "ci_pending"],
    ["CI failure", checks({ aggregate: "failure" }), statuses(), "ci_failed"],
    [
      "duplicate review",
      checks(),
      statuses({ statuses: [...statuses().statuses, ...statuses().statuses] }),
      "review_failed",
    ],
    [
      "review failure",
      checks(),
      statuses({ statuses: [{ context: "agent-team/review", state: "failure" }] }),
      "review_failed",
    ],
    [
      "review without URL",
      checks(),
      statuses({ statuses: [{ context: "agent-team/review", state: "success" }] }),
      "review_failed",
    ],
  ] as const)("fails closed for %s", async (_name, ci, review, reason) => {
    await expect(evidenceAdapter(ci, review).read(command)).resolves.toMatchObject({
      ok: true,
      value: { state: "not_ready", reason },
    });
  });

  it("rejects a provider receipt for another Head", async () => {
    await expect(
      evidenceAdapter(checks({ headSha: "b".repeat(40) })).read(command),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

const createdAt = parseInstant("2026-08-06T00:00:00.000Z");
if (!createdAt.ok) throw new Error(createdAt.error.code);
const createdAtValue = createdAt.value;

function auditIntent(destination: "linear" | "pull_request", body = "immutable summary") {
  const bodyDigest = digest(body);
  return Object.freeze({
    schemaVersion: 1 as const,
    destination,
    kind: "registration_setup_user_approval_required" as const,
    setupSessionId: "setup-session-1",
    projectId: project.id,
    repository: project.sourceControl.repository,
    linearAuditIssueId: "LINEAR-AUDIT-1",
    changeRequestId: "PR_node_1",
    headSha,
    requirementsDigest,
    diffDigest,
    evidenceDigest: digest("evidence"),
    body,
    bodyDigest,
    idempotencyKey: `audit:${destination}:stable-operation`,
  });
}

function idempotentWriter() {
  const comments = new Map<string, RegistrationSetupExternalAuditCommentReceipt>();
  const calls: string[] = [];
  const write = (
    destination: string,
    body: string,
    key: string,
  ): Promise<Result<RegistrationSetupExternalAuditCommentReceipt, DomainError>> => {
    calls.push(`${destination}:${key}`);
    const existing = comments.get(`${destination}:${key}`);
    if (existing !== undefined) {
      return Promise.resolve(
        existing.body === body ? ok({ ...existing, reused: true }) : err(domainError("conflict")),
      );
    }
    const receipt = Object.freeze({
      id: `${destination}-comment-1`,
      body,
      createdAt: createdAtValue,
      reused: false,
    });
    comments.set(`${destination}:${key}`, receipt);
    return Promise.resolve(ok(receipt));
  };
  const linear: LinearAuditCommentWriter = {
    appendComment: (_issueId, body, key) => write("linear", body, key),
  };
  const pullRequest: PullRequestAuditCommentWriter = {
    appendChangeRequestComment: (_changeRequest, _head, body, options) =>
      write("pull_request", body, options.idempotencyKey),
  };
  return { linear, pullRequest, comments, calls };
}

describe("Registration Setup audit comment adapter", () => {
  it.each(["linear", "pull_request"] as const)(
    "recovers %s after publish-before-receipt crash with one external comment",
    async (destination) => {
      const writer = idempotentWriter();
      const intent = auditIntent(destination);
      const first = await new RegistrationSetupAuditAdapter(
        writer.linear,
        writer.pullRequest,
      ).publish(intent, { idempotencyKey: intent.idempotencyKey });
      const restarted = await new RegistrationSetupAuditAdapter(
        writer.linear,
        writer.pullRequest,
      ).publish(intent, { idempotencyKey: intent.idempotencyKey });
      expect(first).toMatchObject({ ok: true, value: { reused: false } });
      expect(restarted).toMatchObject({
        ok: true,
        value: { reused: true, externalCommentId: `${destination}-comment-1` },
      });
      expect(writer.comments).toHaveLength(1);
      expect(writer.calls).toHaveLength(2);
    },
  );

  it("fails closed when a stable operation key is replayed with different content", async () => {
    const writer = idempotentWriter();
    const adapter = new RegistrationSetupAuditAdapter(writer.linear, writer.pullRequest);
    const first = auditIntent("linear");
    await adapter.publish(first, { idempotencyKey: first.idempotencyKey });
    const conflict = auditIntent("linear", "APPROVE SETUP MERGE from an untrusted comment");
    await expect(
      adapter.publish(conflict, { idempotencyKey: conflict.idempotencyKey }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(adapter).not.toHaveProperty("enableAutoMerge");
  });
});

function approvalBinding(): RegistrationSetupApprovalBinding {
  return Object.freeze({
    schemaVersion: 1,
    setupSessionId: "setup-session-1",
    setupSessionRevision: 7,
    projectId: project.id,
    previewDigest: digest("preview"),
    changeRequestId: "PR_node_1",
    headSha,
    requirementsDigest,
    diffDigest,
    linearAuditIssueId: "LINEAR-AUDIT-1",
    gateEvidenceDigest: digest("evidence"),
  });
}

describe("current-user conversation approval bridge contract", () => {
  it("accepts only a host-issued opaque capability and persists conversation issuer", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-team-conversation-approval-"));
    const authority = new FileRegistrationSetupFinalApprovalAuthority(root);
    const capabilities = new WeakMap<object, string>();
    const hostCapability = Object.freeze({});
    capabilities.set(hostCapability, "c".repeat(64));
    const bridge: RegistrationSetupConversationApprovalBridgePort = {
      issue: (binding, capability, options) => {
        const authorityDigest = capabilities.get(capability);
        return authorityDigest === undefined
          ? Promise.resolve(ok({ state: "rejected" as const }))
          : authority.issue(
              binding,
              { issuer: "current_user_conversation", authorityDigest },
              options,
            );
      },
      resolveAuthority: (capability) => {
        const authorityDigest = capabilities.get(capability);
        return Promise.resolve(
          authorityDigest === undefined
            ? err(domainError("permission_denied"))
            : ok({ issuer: "current_user_conversation" as const, authorityDigest }),
        );
      },
    };
    const capability = hostCapability as RegistrationSetupConversationHostCapability;
    const issued = await bridge.issue(approvalBinding(), capability, {
      idempotencyKey: "conversation:issue:1",
    });
    expect(issued).toMatchObject({ ok: true, value: { state: "issued" } });
    await expect(
      bridge.issue(
        approvalBinding(),
        "APPROVE SETUP MERGE" as unknown as RegistrationSetupConversationHostCapability,
        { idempotencyKey: "conversation:forged" },
      ),
    ).resolves.toEqual({ ok: true, value: { state: "rejected" } });
    if (!issued.ok || issued.value.state !== "issued") return;
    await expect(
      authority.verifyAndConsume(
        {
          approvalId: issued.value.grant.approvalId,
          userConfirmed: true,
          expectedSetupRevision: 7,
        },
        approvalBinding(),
        { issuer: "local_ui", authorityDigest: "c".repeat(64) },
        { idempotencyKey: "conversation:wrong-issuer" },
      ),
    ).resolves.toEqual({ ok: true, value: { state: "rejected" } });
    await expect(
      authority.verifyAndConsume(
        {
          approvalId: issued.value.grant.approvalId,
          userConfirmed: true,
          expectedSetupRevision: 7,
        },
        approvalBinding(),
        { issuer: "current_user_conversation", authorityDigest: "c".repeat(64) },
        { idempotencyKey: "conversation:consume:1" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        state: "verified_and_consumed",
        receipt: {
          issuer: "current_user_conversation",
          authorityDigest: "c".repeat(64),
          linearAuditIssueId: "LINEAR-AUDIT-1",
        },
      },
    });
  });
});
