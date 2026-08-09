import { describe, expect, it, vi } from "vitest";

import {
  aggregateLinearPublicationDigest,
  type LinearPublicationReceiptRecord,
} from "../../src/adapters/dispatch/linear-publication-store.js";
import {
  AutoMergeGate,
  REVIEW_STATUS_CONTEXT,
  ReviewStatusCoordinator,
  type MergeGateAutoMergeAttempt,
  type MergeGatePorts,
  type RecordReviewRequest,
  type ReviewerPipelineOutcome,
  type ReviewerReport,
  type ReviewStatusPorts,
} from "../../src/application/pipelines/index.js";
import { canonicalVisualManifestInput } from "../../src/application/pipelines/reviewer-model.js";
import type {
  ChangeRequestSnapshot,
  CommitChecksSnapshot,
  CommitStatusesSnapshot,
} from "../../src/application/ports/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { jobSchema } from "../../src/domain/jobs/index.js";
import { visualManifestSchema } from "../../src/domain/checkpoint/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import {
  createRequirementSnapshot,
  createReviewIdentity,
  evidenceDigestOf,
  type EffectiveTreeChange,
  type RequirementSnapshot,
  type ReviewIdentity,
} from "../../src/domain/review/index.js";

const headSha = "a".repeat(40);
const rebasedHeadSha = "b".repeat(40);
const baseSha = "c".repeat(40);
const objectSha = "d".repeat(40);
const changedObjectSha = "e".repeat(40);

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-05T01:00:00.000Z");
const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Merge gate fixture",
  localRepositoryPath: "/tmp/repository",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});
const issue = issueSchema.parse({
  schemaVersion: 1,
  id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId: project.id,
  externalId: "ENG-123",
  title: "Protect auto merge",
  goal: "Merge only an exactly approved effective diff.",
  acceptanceCriteria: ["The merge gate binds review, CI, diff, requirements, and Head SHA."],
  inScope: ["src/application/pipelines"],
  outOfScope: ["Lifecycle reconciliation"],
  dependencies: { kind: "none" },
  priority: "high",
  agentRole: "implementer",
  reviewRequirement: "code_review",
  estimatedMinutes: 30,
  changeRegions: [{ path: "src/application/pipelines", coverage: "subtree" }],
});
const snapshotResult = createRequirementSnapshot(issue, now);
if (!snapshotResult.ok) throw new Error(snapshotResult.error.code);
const snapshot = snapshotResult.value;
const acceptanceCriterion = issue.acceptanceCriteria?.[0];
if (acceptanceCriterion === undefined) throw new Error("Missing acceptance criterion.");

const diff: readonly EffectiveTreeChange[] = [
  {
    before: null,
    after: {
      path: "src/application/pipelines/feature.ts",
      mode: "100644",
      objectId: { algorithm: "sha1", value: objectSha },
    },
  },
];
const identityResult = createReviewIdentity(snapshot, headSha, diff);
if (!identityResult.ok) throw new Error(identityResult.error.code);
const identity = identityResult.value;

const report: ReviewerReport = {
  schemaVersion: 1,
  role: "code_reviewer",
  verdict: "passed",
  requirementsDigest: identity.requirementsDigest,
  headSha: identity.headSha,
  diffDigest: identity.diffDigest,
  summary: "All checks passed.",
  acceptanceCriteria: [
    {
      criterion: acceptanceCriterion,
      status: "passed",
      summary: "Bound to exact evidence.",
      evidenceSources: ["agent-team:diff"],
    },
  ],
  qualityChecks: [
    {
      dimension: "correctness",
      status: "passed",
      summary: "Correct.",
      evidenceSources: ["agent-team:diff"],
    },
  ],
  findings: [],
};
const job = jobSchema.parse({
  schemaVersion: 1,
  id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId: project.id,
  issueId: issue.id,
  createdAt: now,
  watchdogExtensionGranted: false,
  attempts: { processRecoveries: 0, ciFixRounds: 0, reviewerFixRounds: 0, reviewRuns: 1 },
});

function changeRequest(
  sha = headSha,
  overrides: Partial<ChangeRequestSnapshot> = {},
): ChangeRequestSnapshot {
  return {
    id: "PR_node_fixture",
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
    state: "open",
    draft: false,
    baseBranch: "main",
    headBranch: "task/ENG-123",
    headSha: sha,
    mergeability: "mergeable",
    autoMergeEnabled: false,
    updatedAt: now,
    ...overrides,
  };
}

function checks(
  sha = headSha,
  aggregate: CommitChecksSnapshot["aggregate"] = "success",
): CommitChecksSnapshot {
  return {
    headSha: sha,
    aggregate,
    checks: [
      {
        name: "quality",
        status: aggregate === "pending" ? "in_progress" : "completed",
        conclusion:
          aggregate === "success" ? "success" : aggregate === "failure" ? "failure" : null,
      },
    ],
  };
}

function statuses(
  sha = headSha,
  state: "pending" | "success" | "failure" | "error" = "success",
): CommitStatusesSnapshot {
  return { headSha: sha, statuses: [{ context: REVIEW_STATUS_CONTEXT, state }] };
}

function approvedDecision(
  overrides: Partial<Extract<ReviewerPipelineOutcome, { state: "approved" }>> = {},
): Extract<ReviewerPipelineOutcome, { state: "approved" }> {
  return {
    state: "approved",
    job,
    changeRequest: changeRequest(),
    checks: checks(),
    identity,
    reports: [report],
    ...overrides,
  };
}

function reviewPorts(
  options: {
    cr?: ChangeRequestSnapshot;
    checks?: CommitChecksSnapshot;
    statuses?: CommitStatusesSnapshot;
    calls?: string[];
  } = {},
): ReviewStatusPorts {
  const calls = options.calls ?? [];
  return {
    sourceControl: {
      getChangeRequest: vi.fn(() => Promise.resolve(ok(options.cr ?? changeRequest()))),
      getCommitChecks: vi.fn(() => Promise.resolve(ok(options.checks ?? checks()))),
      getCommitStatuses: vi.fn(() =>
        Promise.resolve(ok(options.statuses ?? statuses(headSha, "pending"))),
      ),
      appendChangeRequestComment: vi.fn(() => {
        calls.push("comment");
        return Promise.resolve(
          ok({
            id: "100",
            url: "https://github.com/owner/repository/pull/42#issuecomment-100",
            createdAt: now,
          }),
        );
      }),
      setCommitStatus: vi.fn(() => {
        calls.push("status");
        return Promise.resolve(ok(undefined));
      }),
    },
  };
}

function recordRequest(
  decision: RecordReviewRequest["decision"] = approvedDecision(),
): RecordReviewRequest {
  return {
    project,
    changeRequestId: "42",
    expectedHeadSha: headSha,
    idempotencyKeyPrefix: "job:ENG-123:review",
    decision,
  };
}

function mergePorts(
  options: {
    sha?: string;
    cr?: ChangeRequestSnapshot;
    checks?: CommitChecksSnapshot;
    statuses?: CommitStatusesSnapshot;
    diff?: readonly EffectiveTreeChange[];
    calls?: string[];
    enableAutoMergeAttempt?: MergeGateAutoMergeAttempt;
    /** E116cap: defaults to `false` -- every pre-existing test in this file exercises the ordinary
     * (never-paused) path, unaffected by the new gate check. */
    paused?: boolean;
    isPausedResult?: Awaited<ReturnType<MergeGatePorts["autoMergePause"]["isPaused"]>>;
  } = {},
): MergeGatePorts {
  const sha = options.sha ?? headSha;
  const calls = options.calls ?? [];
  return {
    git: { getEffectiveTreeDiff: vi.fn(() => Promise.resolve(ok(options.diff ?? diff))) },
    autoMergePause: {
      isPaused: vi.fn(() => {
        calls.push("auto_merge_pause_check");
        return Promise.resolve(options.isPausedResult ?? ok({ paused: options.paused ?? false }));
      }),
    },
    sourceControl: {
      getChangeRequest: vi.fn(() => Promise.resolve(ok(options.cr ?? changeRequest(sha)))),
      getCommitChecks: vi.fn(() => Promise.resolve(ok(options.checks ?? checks(sha)))),
      getCommitStatuses: vi.fn(() => Promise.resolve(ok(options.statuses ?? statuses(sha)))),
      appendChangeRequestComment: vi.fn(() => {
        calls.push("comment");
        return Promise.resolve(
          ok({
            id: "101",
            url: "https://github.com/owner/repository/pull/42#issuecomment-101",
            createdAt: now,
          }),
        );
      }),
      setCommitStatus: vi.fn(() => {
        calls.push("status");
        return Promise.resolve(ok(undefined));
      }),
      enableAutoMerge: vi.fn(() => {
        calls.push("auto_merge");
        return Promise.resolve(
          ok(
            options.enableAutoMergeAttempt ?? {
              outcome: "enabled" as const,
              changeRequest: changeRequest(sha, { autoMergeEnabled: true }),
            },
          ),
        );
      }),
    },
  };
}

function approval() {
  return {
    changeRequestId: "42",
    identity,
    reports: [report],
    evidenceComment: {
      id: "100",
      url: "https://github.com/owner/repository/pull/42#issuecomment-100",
      createdAt: now,
    },
  } as const;
}

function mergeRequest(
  expectedHeadSha = headSha,
  requirementSnapshot: RequirementSnapshot = snapshot,
) {
  return {
    project,
    changeRequestId: "42",
    expectedHeadSha,
    idempotencyKeyPrefix: "job:ENG-123:merge",
    requirementSnapshot,
    baseRevision: baseSha,
    approval: approval(),
  };
}

const dualIssue = issueSchema.parse({
  ...issue,
  id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ac",
  externalId: "ENG-124",
  reviewRequirement: "dual_review",
});
const dualSnapshotResult = createRequirementSnapshot(dualIssue, now);
if (!dualSnapshotResult.ok) throw new Error(dualSnapshotResult.error.code);
const dualSnapshot = dualSnapshotResult.value;
const dualAcceptanceCriterion =
  dualIssue.acceptanceCriteria?.[0] ??
  (() => {
    throw new Error("Missing dual acceptance criterion.");
  })();

function dualManifest(artifactSha: string) {
  return visualManifestSchema.parse({
    schemaVersion: 1,
    issueId: dualIssue.id,
    commitSha: headSha,
    generatedAt: now,
    environment: { runner: "playwright", operatingSystem: "linux", applicationVersion: "1.2.3" },
    artifacts: [
      {
        path: ".agent-team/evidence/ENG-124/status.png",
        sha256: artifactSha,
        mediaType: "image/png",
        title: "Visual evidence",
        acceptanceCriteria: [dualAcceptanceCriterion],
      },
    ],
  });
}

function dualReceipt(manifest: ReturnType<typeof dualManifest>): LinearPublicationReceiptRecord {
  return {
    schemaVersion: 1,
    projectId: project.id,
    issueId: dualIssue.id,
    externalIssueId: dualIssue.externalId,
    headSha: identity.headSha,
    manifestDigest: "b".repeat(64),
    manifestComment: { id: "manifest-comment", sha256: "c".repeat(64) },
    artifacts: manifest.artifacts.map((artifact) => ({
      path: artifact.path,
      sha256: artifact.sha256,
      assetUrl: "https://uploads.linear.app/asset-1",
      commentId: "artifact-comment",
    })),
    createdAt: now,
  };
}

function dualReport(dualIdentity: ReviewIdentity, role: ReviewerReport["role"]): ReviewerReport {
  return {
    ...report,
    role,
    requirementsDigest: dualIdentity.requirementsDigest,
    headSha: dualIdentity.headSha,
    diffDigest: dualIdentity.diffDigest,
    ...(dualIdentity.evidenceDigest === undefined
      ? {}
      : { evidenceDigest: dualIdentity.evidenceDigest }),
    ...(dualIdentity.publicationDigest === undefined
      ? {}
      : { publicationDigest: dualIdentity.publicationDigest }),
    acceptanceCriteria: report.acceptanceCriteria.map((criterion) => ({
      ...criterion,
      criterion: dualAcceptanceCriterion,
    })),
  };
}

function dualApproval(dualIdentity: ReviewIdentity, reports: readonly ReviewerReport[]) {
  return {
    changeRequestId: "42",
    identity: dualIdentity,
    reports,
    evidenceComment: {
      id: "100",
      url: "https://github.com/owner/repository/pull/42#issuecomment-100",
      createdAt: now,
    },
  } as const;
}

function dualMergeRequest(
  dualApprovalValue: ReturnType<typeof dualApproval>,
  currentVisualManifest: ReturnType<typeof dualManifest>,
  currentPublicationDigest: string,
) {
  return {
    ...mergeRequest(headSha, dualSnapshot),
    approval: dualApprovalValue,
    currentVisualManifest,
    currentPublicationDigest,
  };
}

describe("review commit status coordination", () => {
  it("sets pending only after exact-Head successful CI and allows the PR to remain Draft", async () => {
    const calls: string[] = [];
    const ports = reviewPorts({ cr: changeRequest(headSha, { draft: true }), calls });
    const outcome = await new ReviewStatusCoordinator(ports).begin({
      project,
      changeRequestId: "42",
      expectedHeadSha: headSha,
      idempotencyKeyPrefix: "job:ENG-123:review",
    });

    expect(outcome.state).toBe("pending");
    expect(calls).toEqual(["status"]);
    expect(ports.sourceControl.setCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha,
        context: REVIEW_STATUS_CONTEXT,
        state: "pending",
      }),
      expect.anything(),
    );
  });

  it("does not start on red CI and never downgrades an existing success", async () => {
    const red = reviewPorts({ checks: checks(headSha, "failure") });
    expect(
      await new ReviewStatusCoordinator(red).begin({
        project,
        changeRequestId: "42",
        expectedHeadSha: headSha,
        idempotencyKeyPrefix: "review:red",
      }),
    ).toMatchObject({ state: "not_ready", reason: "ci_failed" });
    expect(red.sourceControl.setCommitStatus).not.toHaveBeenCalled();

    const complete = reviewPorts({ statuses: statuses(headSha, "success") });
    expect(
      await new ReviewStatusCoordinator(complete).begin({
        project,
        changeRequestId: "42",
        expectedHeadSha: headSha,
        idempotencyKeyPrefix: "review:complete",
      }),
    ).toMatchObject({ state: "already_approved" });
    expect(complete.sourceControl.setCommitStatus).not.toHaveBeenCalled();
  });

  it("records structured evidence before publishing exact-SHA success", async () => {
    const calls: string[] = [];
    const ports = reviewPorts({ calls });
    const outcome = await new ReviewStatusCoordinator(ports).record(recordRequest());

    expect(outcome.state).toBe("approved");
    expect(calls).toEqual(["comment", "status"]);
    const append = vi.mocked(ports.sourceControl.appendChangeRequestComment);
    expect(append.mock.calls[0]?.[0].body).toContain('"diffDigest"');
    expect(ports.sourceControl.appendChangeRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: headSha }),
      expect.anything(),
    );
    expect(ports.sourceControl.setCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ headSha, state: "success" }),
      expect.anything(),
    );
  });

  it("rejects stale reviewer evidence before any mutation", async () => {
    const ports = reviewPorts();
    const staleIdentity = createReviewIdentity(snapshot, rebasedHeadSha, diff);
    if (!staleIdentity.ok) throw new Error(staleIdentity.error.code);
    const outcome = await new ReviewStatusCoordinator(ports).record(
      recordRequest(approvedDecision({ identity: staleIdentity.value })),
    );

    expect(outcome).toMatchObject({ state: "failed", stage: "request" });
    expect(ports.sourceControl.appendChangeRequestComment).not.toHaveBeenCalled();
    expect(ports.sourceControl.setCommitStatus).not.toHaveBeenCalled();
  });
});

describe("auto-merge gate", () => {
  it("enables auto-merge only after unchanged identity, CI, status, and race read-back", async () => {
    const calls: string[] = [];
    const ports = mergePorts({ calls });
    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toMatchObject({ state: "auto_merge_enabled", reuse: "unchanged", identity });
    expect(calls).toEqual(["auto_merge_pause_check", "auto_merge"]);
    expect(ports.sourceControl.getChangeRequest).toHaveBeenCalledTimes(2);
    expect(ports.sourceControl.enableAutoMerge).toHaveBeenCalledWith(
      expect.anything(),
      headSha,
      expect.anything(),
    );
  });

  it("reuses approval after a rebase only after CI and records the reuse before merge", async () => {
    const calls: string[] = [];
    const ports = mergePorts({ sha: rebasedHeadSha, calls });
    const outcome = await new AutoMergeGate(ports).enable(mergeRequest(rebasedHeadSha));

    expect(outcome).toMatchObject({ state: "auto_merge_enabled", reuse: "ci_revalidation" });
    expect(calls).toEqual(["auto_merge_pause_check", "comment", "status", "auto_merge"]);
    const append = vi.mocked(ports.sourceControl.appendChangeRequestComment);
    expect(append.mock.calls[0]?.[0].body).toContain("ci_revalidated_without_new_reviewer_run");
    expect(ports.sourceControl.appendChangeRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: rebasedHeadSha }),
      expect.anything(),
    );
  });

  it("invalidates approval when the effective diff changes", async () => {
    const changedDiff: readonly EffectiveTreeChange[] = [
      {
        before: null,
        after: {
          path: "src/application/pipelines/feature.ts",
          mode: "100644",
          objectId: { algorithm: "sha1", value: changedObjectSha },
        },
      },
    ];
    const calls: string[] = [];
    const ports = mergePorts({ diff: changedDiff, calls });
    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toMatchObject({
      state: "re_review_required",
      reason: "effective_diff_changed",
    });
    expect(calls).toEqual(["auto_merge_pause_check", "comment", "status"]);
    expect(ports.sourceControl.enableAutoMerge).not.toHaveBeenCalled();
  });

  it("invalidates approval when requirements change", async () => {
    const changedIssue = issueSchema.parse({ ...issue, goal: "A materially changed goal." });
    const changedSnapshot = createRequirementSnapshot(changedIssue, now);
    if (!changedSnapshot.ok) throw new Error(changedSnapshot.error.code);
    const ports = mergePorts();
    const outcome = await new AutoMergeGate(ports).enable(
      mergeRequest(headSha, changedSnapshot.value),
    );

    expect(outcome).toMatchObject({ state: "re_review_required", reason: "requirements_changed" });
    expect(ports.sourceControl.enableAutoMerge).not.toHaveBeenCalled();
  });

  it("fails closed when the recorded approval does not contain a passing required reviewer", async () => {
    const ports = mergePorts();
    const outcome = await new AutoMergeGate(ports).enable({
      ...mergeRequest(),
      approval: {
        ...approval(),
        reports: [{ ...report, verdict: "changes_requested" }],
      },
    });

    expect(outcome).toMatchObject({ state: "failed", stage: "request" });
    expect(ports.sourceControl.getChangeRequest).not.toHaveBeenCalled();
    expect(ports.sourceControl.enableAutoMerge).not.toHaveBeenCalled();
  });

  it("keeps code_review-only approvals without evidence digests eligible for auto-merge", async () => {
    const outcome = await new AutoMergeGate(mergePorts()).enable(mergeRequest());
    expect(outcome).toMatchObject({ state: "auto_merge_enabled", identity });
  });

  it("requires matching evidence and publication digests on every dual-review report", async () => {
    const manifest = dualManifest("d".repeat(64));
    const publicationDigest = aggregateLinearPublicationDigest([dualReceipt(manifest)]);
    const created = createReviewIdentity(dualSnapshot, headSha, diff, {
      visualManifest: canonicalVisualManifestInput(manifest),
      publicationDigest,
    });
    if (!created.ok) throw new Error(created.error.code);
    const codeReport = dualReport(created.value, "code_reviewer");
    const visualReport = dualReport(created.value, "visual_reviewer");
    const valid = dualMergeRequest(
      dualApproval(created.value, [codeReport, visualReport]),
      manifest,
      publicationDigest,
    );

    expect(await new AutoMergeGate(mergePorts()).enable(valid)).toMatchObject({
      state: "auto_merge_enabled",
    });
    for (const invalidReports of [
      [{ ...codeReport, evidenceDigest: undefined }, visualReport],
      [{ ...codeReport, evidenceDigest: "f".repeat(64) }, visualReport],
      [{ ...codeReport, publicationDigest: undefined }, visualReport],
      [{ ...codeReport, publicationDigest: "f".repeat(64) }, visualReport],
    ] as const) {
      expect(
        await new AutoMergeGate(mergePorts()).enable({
          ...valid,
          approval: dualApproval(created.value, invalidReports),
        }),
      ).toMatchObject({ state: "failed", stage: "request" });
    }
  });

  it("E102-4b: blocks merge with a distinct evidence_drift_detected outcome (never re_review_required/effective_diff_changed) when a visual artifact's SHA-256 changes at the identical commit", async () => {
    const manifestV1 = dualManifest("d".repeat(64));
    const receiptV1 = dualReceipt(manifestV1);
    const publicationDigestV1 = aggregateLinearPublicationDigest([receiptV1]);
    const approved = createReviewIdentity(dualSnapshot, headSha, diff, {
      visualManifest: canonicalVisualManifestInput(manifestV1),
      publicationDigest: publicationDigestV1,
    });
    if (!approved.ok) throw new Error(approved.error.code);
    const approvalValue = dualApproval(approved.value, [
      dualReport(approved.value, "code_reviewer"),
      dualReport(approved.value, "visual_reviewer"),
    ]);
    const controlPorts = mergePorts();
    expect(
      await new AutoMergeGate(controlPorts).enable(
        dualMergeRequest(approvalValue, manifestV1, publicationDigestV1),
      ),
    ).toMatchObject({ state: "auto_merge_enabled" });

    const manifestV2 = dualManifest("e".repeat(64));
    const evidenceDigestV1 = evidenceDigestOf(canonicalVisualManifestInput(manifestV1));
    const evidenceDigestV2 = evidenceDigestOf(canonicalVisualManifestInput(manifestV2));
    if (!evidenceDigestV1.ok || !evidenceDigestV2.ok) throw new Error("fixture invariant violated");
    expect(evidenceDigestV2.value).not.toBe(evidenceDigestV1.value);
    const driftCalls: string[] = [];
    const driftPorts = mergePorts({ calls: driftCalls });
    const outcome = await new AutoMergeGate(driftPorts).enable(
      dualMergeRequest(approvalValue, manifestV2, publicationDigestV1),
    );
    // E102-4b: same head SHA, same requirements, same effective diff -- only the freshly
    // re-verified visual evidence differs from what the recorded approval was reviewed against.
    // This is never routed back through `re_review_required` (that reasonCode means "send it back
    // through the normal implementer/reviewer loop," which cannot resolve a same-commit evidence
    // mismatch and would silently hide a potential tampering/corruption signal behind a
    // routine-looking label -- see `EnableAutoMergeOutcome.evidence_drift_detected`'s own header,
    // merge-gate-model.ts).
    expect(outcome).toMatchObject({ state: "evidence_drift_detected" });
    expect(outcome).toHaveProperty("identity");
    expect(outcome).not.toMatchObject({ state: "re_review_required" });
    expect(driftPorts.sourceControl.enableAutoMerge).not.toHaveBeenCalled();
    expect(driftCalls).toEqual(["auto_merge_pause_check", "comment", "status"]);
    const append = vi.mocked(driftPorts.sourceControl.appendChangeRequestComment);
    const body = append.mock.calls[0]?.[0].body ?? "";
    expect(body).toContain("evidence_drift_detected");
    // Never the wording a genuine full-review invalidation posts -- a human reading this comment
    // must not mistake it for "the implementer's diff changed."
    expect(body).not.toContain("full_review_required");
    expect(body).toContain("manual_review_required");
    const status = vi.mocked(driftPorts.sourceControl.setCommitStatus);
    expect(status.mock.calls[0]?.[0].description).toContain("evidence drift detected");
  });

  it("E102-4b: blocks merge with a distinct publication_drift_detected outcome (never re_review_required/effective_diff_changed) when a Linear receipt's content changes at the identical commit", async () => {
    const manifestV1 = dualManifest("d".repeat(64));
    const receiptV1 = dualReceipt(manifestV1);
    const publicationDigestV1 = aggregateLinearPublicationDigest([receiptV1]);
    const approved = createReviewIdentity(dualSnapshot, headSha, diff, {
      visualManifest: canonicalVisualManifestInput(manifestV1),
      publicationDigest: publicationDigestV1,
    });
    if (!approved.ok) throw new Error(approved.error.code);
    const approvalValue = dualApproval(approved.value, [
      dualReport(approved.value, "code_reviewer"),
      dualReport(approved.value, "visual_reviewer"),
    ]);
    const receiptV2: LinearPublicationReceiptRecord = {
      ...receiptV1,
      manifestComment: { ...receiptV1.manifestComment, sha256: "e".repeat(64) },
    };
    const publicationDigestV2 = aggregateLinearPublicationDigest([receiptV2]);
    expect(publicationDigestV2).not.toBe(publicationDigestV1);
    const driftCalls: string[] = [];
    const driftPorts = mergePorts({ calls: driftCalls });
    const outcome = await new AutoMergeGate(driftPorts).enable(
      dualMergeRequest(approvalValue, manifestV1, publicationDigestV2),
    );
    expect(outcome).toMatchObject({ state: "publication_drift_detected" });
    expect(outcome).not.toMatchObject({ state: "re_review_required" });
    expect(driftPorts.sourceControl.enableAutoMerge).not.toHaveBeenCalled();
    expect(driftCalls).toEqual(["auto_merge_pause_check", "comment", "status"]);
    const append = vi.mocked(driftPorts.sourceControl.appendChangeRequestComment);
    const body = append.mock.calls[0]?.[0].body ?? "";
    expect(body).toContain("publication_drift_detected");
    expect(body).not.toContain("full_review_required");
  });

  it.each([
    ["draft", { cr: changeRequest(headSha, { draft: true }) }, "draft"],
    ["conflict", { cr: changeRequest(headSha, { mergeability: "conflicting" }) }, "merge_conflict"],
    ["red CI", { checks: checks(headSha, "failure") }, "ci_failed"],
    ["missing review status", { statuses: statuses(headSha, "pending") }, "review_status_missing"],
    // C015y decision D (arm-time interception, point 1 of 3): `mergePorts`'s own `getChangeRequest`
    // fake returns the *same* `cr` for every call, so this one row exercises both the very first
    // readback and the pre-merge readback simultaneously -- see the dedicated test below for the
    // narrower "only becomes behind between the two reads" case.
    ["BEHIND", { cr: changeRequest(headSha, { mergeStateStatus: "behind" }) }, "behind"],
  ] as const)("does not merge when %s blocks the gate", async (_name, options, reason) => {
    const ports = mergePorts(options);
    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toMatchObject({ state: "not_ready", reason });
    expect(ports.sourceControl.enableAutoMerge).not.toHaveBeenCalled();
  });

  it("C015y decision D (arm-time interception, point 2 of 3): a PR that is only BEHIND at the immediately-pre-merge readback (first read still clean) is still caught before enableAutoMerge is ever called", async () => {
    const ports = mergePorts();
    const getChangeRequest = vi.mocked(ports.sourceControl.getChangeRequest);
    getChangeRequest
      .mockResolvedValueOnce(ok(changeRequest(headSha))) // the very first readback: clean
      .mockResolvedValueOnce(ok(changeRequest(headSha, { mergeStateStatus: "behind" }))); // pre-merge: behind

    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toMatchObject({ state: "not_ready", reason: "behind" });
    expect(ports.sourceControl.enableAutoMerge).not.toHaveBeenCalled();
  });
});

/**
 * E116cap: `MergeGatePorts.autoMergePause` gates `AutoMergeGate.enable()` before any other
 * readiness check -- the structural enforcement point behind `resume-composition.ts`'s own
 * `case "auto_merge_paused":` (which only maps the outcome to a dedicated `requires_manual`
 * reasonCode, never re-derives the decision itself). See `merge-gate-model.ts`'s own header on
 * `MergeGatePorts.autoMergePause` for why this is an unconditional short-circuit.
 */
describe("auto-merge gate: E116cap project pause gate", () => {
  it("never even reads the change request when the project is paused", async () => {
    const calls: string[] = [];
    const ports = mergePorts({ calls, paused: true });
    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toEqual({ state: "not_ready", reason: "auto_merge_paused" });
    expect(calls).toEqual(["auto_merge_pause_check"]);
    expect(ports.sourceControl.getChangeRequest).not.toHaveBeenCalled();
    expect(ports.sourceControl.enableAutoMerge).not.toHaveBeenCalled();
  });

  it("fails closed (stage:policy) when the pause query port itself errors, never defaulting to unpaused", async () => {
    const ports = mergePorts({ isPausedResult: err(domainError("external_failure")) });
    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toMatchObject({ state: "failed", stage: "policy" });
    expect(ports.sourceControl.getChangeRequest).not.toHaveBeenCalled();
    expect(ports.sourceControl.enableAutoMerge).not.toHaveBeenCalled();
  });

  it("proceeds exactly as before this ticket when the project is not paused (no regression)", async () => {
    const calls: string[] = [];
    const ports = mergePorts({ calls, paused: false });
    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toMatchObject({ state: "auto_merge_enabled" });
    expect(calls).toEqual(["auto_merge_pause_check", "auto_merge"]);
  });
});

/**
 * C015t decision 1 acceptance criterion ①: each of the union's newly-introduced/renamed branches
 * gets its own dedicated test -- `auto_merge_enabled` is already covered above (renamed from
 * `"enabled"`); this block covers `directly_merged` and both ways `already_merged_external` can be
 * reached (the very first readback, and the port's own `enableAutoMerge` call reporting an
 * already-merged snapshot).
 */
describe("auto-merge gate: C015t decision 1 merge outcomes", () => {
  it("directly_merged: the enableAutoMerge port call itself performed the squash fallback", async () => {
    const calls: string[] = [];
    const ports = mergePorts({
      calls,
      enableAutoMergeAttempt: {
        outcome: "merged_directly",
        changeRequest: changeRequest(headSha, { state: "merged", autoMergeEnabled: false }),
      },
    });
    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toMatchObject({
      state: "directly_merged",
      changeRequest: { state: "merged", headSha },
    });
    expect(calls).toEqual(["auto_merge_pause_check", "auto_merge"]);
  });

  it("already_merged_external: the enableAutoMerge port call found it already merged by something else", async () => {
    const ports = mergePorts({
      enableAutoMergeAttempt: {
        outcome: "merged_externally",
        changeRequest: changeRequest(headSha, { state: "merged", autoMergeEnabled: false }),
      },
    });
    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toMatchObject({
      state: "already_merged_external",
      changeRequest: { state: "merged", headSha },
    });
  });

  it("already_merged_external: detected at the very first readback, before enableAutoMerge is ever called", async () => {
    const ports = mergePorts({ cr: changeRequest(headSha, { state: "merged" }) });
    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toMatchObject({
      state: "already_merged_external",
      changeRequest: { state: "merged", headSha },
    });
    expect(ports.sourceControl.enableAutoMerge).not.toHaveBeenCalled();
  });

  it("already_merged_external: detected at the pre-merge readback (first read still open, second read merged)", async () => {
    const calls: string[] = [];
    const ports = mergePorts({ calls });
    const getChangeRequest = vi.mocked(ports.sourceControl.getChangeRequest);
    getChangeRequest
      .mockResolvedValueOnce(ok(changeRequest(headSha))) // the very first readback: still open
      .mockResolvedValueOnce(ok(changeRequest(headSha, { state: "merged" }))); // the pre-merge readback: merged

    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toMatchObject({
      state: "already_merged_external",
      changeRequest: { state: "merged", headSha },
    });
    expect(ports.sourceControl.enableAutoMerge).not.toHaveBeenCalled();
    expect(calls).toEqual(["auto_merge_pause_check"]);
  });

  it("rejects a merged_directly/merged_externally attempt whose head SHA does not match (fails closed, never assumed authorized)", async () => {
    const ports = mergePorts({
      enableAutoMergeAttempt: {
        outcome: "merged_directly",
        changeRequest: changeRequest(rebasedHeadSha, { state: "merged" }),
      },
    });
    const outcome = await new AutoMergeGate(ports).enable(mergeRequest());

    expect(outcome).toMatchObject({
      state: "failed",
      stage: "auto_merge",
      error: { code: "conflict" },
    });
  });
});
