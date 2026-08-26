import { describe, expect, it } from "vitest";

import {
  ReviewerPipeline,
  type ReviewerPipelinePorts,
  type ReviewerPipelineRequest,
  type ReviewQualityDimension,
  type ReviewerReport,
} from "../../src/application/pipelines/index.js";
import {
  canonicalVisualManifestInput,
  reviewFindingSchema,
} from "../../src/application/pipelines/reviewer-model.js";
import {
  computeReviewerReportContractDigest,
  reviewerReportContractDigest,
  reviewerReportContractVersion,
} from "../../src/application/pipelines/reviewer-policy.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import type {
  ProviderEvent,
  ProviderRunHandle,
  ProviderRunRequest,
} from "../../src/application/ports/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { jobSchema, type JobAttemptCounters } from "../../src/domain/jobs/index.js";
import {
  issueSchema,
  projectSchema,
  type ReviewRequirement,
} from "../../src/domain/project/index.js";
import {
  createRequirementSnapshot,
  createReviewIdentity,
  type EffectiveTreeChange,
  type RequirementSnapshot,
  type ReviewIdentity,
} from "../../src/domain/review/index.js";
import { visualManifestSchema } from "../../src/domain/checkpoint/index.js";
import {
  jobSkillSnapshotSchema,
  skillRuntimeFailure,
  type SkillRuntimePort,
} from "../../src/application/skills/index.js";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const objectSha = "c".repeat(40);
const artifactSha = "d".repeat(64);
const acceptanceCriterion = "The review binds to exact evidence.";
const codeQualityDimensions = [
  "test_effectiveness",
  "correctness",
  "error_handling",
  "boundaries",
  "security",
  "secrets",
  "readability",
  "module_boundaries",
  "maintainability",
  "duplication_overdesign",
  "compatibility",
  "scope",
  "documentation_migrations",
] as const satisfies readonly ReviewQualityDimension[];
const visualQualityDimensions = [
  "layout",
  "spacing",
  "hierarchy",
  "readability",
  "style_consistency",
  "sizes_states",
  "accessibility",
  "broken_assets_clipping_flicker",
  "visual_regression",
] as const satisfies readonly ReviewQualityDimension[];

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-05T00:00:00.000Z");
const deadline = instant("2026-08-05T00:30:00.000Z");
const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Reviewer fixture",
  localRepositoryPath: "/tmp/repository",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});
const worktree = {
  repositoryRoot: project.localRepositoryPath,
  path: "/tmp/reviewer-worktree",
  branch: "feature/ENG-123-review",
  headSha,
} as const;
const diff: readonly EffectiveTreeChange[] = [
  {
    before: null,
    after: {
      path: "src/feature.ts",
      mode: "100644",
      objectId: { algorithm: "sha1", value: objectSha },
    },
  },
];

function context(reviewRequirement: ReviewRequirement) {
  const issue = issueSchema.parse({
    schemaVersion: 1,
    id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: project.id,
    externalId: "ENG-123",
    title: "Review pipeline",
    goal: "Review an exact diff with fresh context.",
    background: "CI is green.",
    acceptanceCriteria: [acceptanceCriterion],
    inScope: ["src"],
    outOfScope: ["Implementer conversation"],
    dependencies: { kind: "none" },
    priority: "high",
    agentRole: "implementer",
    reviewRequirement,
    estimatedMinutes: 30,
    changeRegions: [{ path: "src", coverage: "subtree" }],
  });
  const snapshot = createRequirementSnapshot(issue, now);
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  const identity = createReviewIdentity(snapshot.value, headSha, diff);
  if (!identity.ok) throw new Error(identity.error.code);
  return { issue, snapshot: snapshot.value, identity: identity.value };
}

function firstCriterion(snapshot: RequirementSnapshot): string {
  const criterion = snapshot.issue.acceptanceCriteria?.[0];
  if (criterion === undefined) throw new Error("Missing fixture acceptance criterion.");
  return criterion;
}

const config = trustedProjectConfigSchema.parse({
  schemaVersion: 1,
  projectId: project.id,
  defaultBranch: "main",
  platforms: {
    workManagement: project.workManagement,
    sourceControl: project.sourceControl,
  },
  projectRules: ["Review exact Head only."],
  roleInstructions: {
    code_reviewer: ["Check code quality."],
    visual_reviewer: ["Check observable visual evidence."],
  },
  commands: {
    quality: [{ executable: "pnpm", arguments: ["test"] }],
    visualReview: [{ executable: "pnpm", arguments: ["test:visual"] }],
  },
});

function job(snapshot: RequirementSnapshot, attempts: Partial<JobAttemptCounters> = {}) {
  return jobSchema.parse({
    schemaVersion: 1,
    id: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: project.id,
    issueId: snapshot.issue.id,
    createdAt: now,
    watchdogExtensionGranted: false,
    attempts: {
      processRecoveries: 0,
      ciFixRounds: 0,
      reviewerFixRounds: 0,
      reviewRuns: 0,
      ...attempts,
    },
  });
}

function request(
  reviewRequirement: ReviewRequirement,
  attempts: Partial<JobAttemptCounters> = {},
  overrides: Partial<ReviewerPipelineRequest> = {},
) {
  const review = context(reviewRequirement);
  const needsCode = reviewRequirement !== "visual_review";
  const needsVisual = reviewRequirement !== "code_review";
  const visualManifest = needsVisual
    ? visualManifestSchema.parse({
        schemaVersion: 1 as const,
        issueId: review.issue.id,
        commitSha: headSha,
        generatedAt: now,
        environment: { runner: "fixture", operatingSystem: "linux" },
        artifacts: [
          {
            path: "evidence/screen.png",
            mediaType: "image/png",
            sha256: artifactSha,
            title: "Screen",
            acceptanceCriteria: [firstCriterion(review.snapshot)],
          },
        ],
      })
    : undefined;
  const evidence = needsVisual
    ? [
        {
          kind: "file" as const,
          category: "visual_artifact" as const,
          source: "artifact:screen",
          mediaType: "image/png",
          path: "/tmp/reviewer-worktree/evidence/screen.png",
          sha256: artifactSha,
          repositoryPath: "evidence/screen.png",
        },
      ]
    : [
        {
          kind: "text" as const,
          category: "known_issue" as const,
          source: "known:compatibility",
          mediaType: "text/plain",
          content: "Known compatibility boundary.",
        },
      ];
  return {
    review,
    value: {
      job: job(review.snapshot, attempts),
      project,
      trustedConfig: config,
      requirementSnapshot: review.snapshot,
      worktree,
      changeRequestId: "42",
      baseRevision: baseSha,
      expectedHeadSha: headSha,
      models: {
        ...(needsCode ? { code: "gpt-review" } : {}),
        ...(needsVisual ? { visual: "gemini-visual" } : {}),
      },
      evidence,
      ...(visualManifest === undefined ? {} : { visualManifest }),
      deadlineAt: deadline,
      idempotencyKeyPrefix: "job:ENG-123:review",
      ...overrides,
    } satisfies ReviewerPipelineRequest,
  };
}

function identityForRequest(input: ReviewerPipelineRequest): ReviewIdentity {
  const created = createReviewIdentity(input.requirementSnapshot, input.expectedHeadSha, diff, {
    ...(input.visualManifest === undefined
      ? {}
      : { visualManifest: canonicalVisualManifestInput(input.visualManifest) }),
    ...(input.publicationDigest === undefined
      ? {}
      : { publicationDigest: input.publicationDigest }),
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

function report(
  role: "code_reviewer" | "visual_reviewer",
  identity: ReviewIdentity,
  verdict: ReviewerReport["verdict"] = "passed",
  findings: ReviewerReport["findings"] = [],
): ReviewerReport {
  const evidenceSources = [role === "visual_reviewer" ? "artifact:screen" : "agent-team:diff"];
  const qualityDimensions =
    role === "code_reviewer" ? codeQualityDimensions : visualQualityDimensions;
  return {
    schemaVersion: 1,
    role,
    verdict,
    requirementsDigest: identity.requirementsDigest,
    headSha: identity.headSha,
    diffDigest: identity.diffDigest,
    ...(identity.evidenceDigest === undefined ? {} : { evidenceDigest: identity.evidenceDigest }),
    ...(identity.publicationDigest === undefined
      ? {}
      : { publicationDigest: identity.publicationDigest }),
    summary:
      verdict === "passed" ? "All acceptance and quality checks passed." : "Review found issues.",
    acceptanceCriteria: [
      {
        criterion: acceptanceCriterion,
        status:
          verdict === "changes_requested"
            ? "failed"
            : verdict === "clarification_required"
              ? "clarification_required"
              : "passed",
        summary: "The approved criterion was reviewed.",
        evidenceSources,
      },
    ],
    qualityChecks: qualityDimensions.map((dimension, index) => ({
      dimension,
      status: verdict === "changes_requested" && index === 0 ? "failed" : "passed",
      summary: `Reviewed ${dimension}.`,
      evidenceSources,
    })),
    findings,
  };
}

function handle(
  output: unknown,
  events: readonly ProviderEvent[] = [],
  completion:
    | Readonly<{ outcome: "completed"; sessionId?: string }>
    | Readonly<{ outcome: "failed"; error: DomainError }> = {
    outcome: "completed",
    sessionId: "fresh-session",
  },
): ProviderRunHandle {
  return {
    runId: `review-${Math.random().toString(16)}`,
    events: {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (const event of events) yield event;
        yield {
          kind: "output",
          observedAt: now,
          stream: "stdout",
          text: typeof output === "string" ? output : JSON.stringify(output),
        } as const;
      },
    },
    completion: () => Promise.resolve(ok(completion)),
    respondToToolRequest: () => Promise.resolve(ok(undefined)),
    interrupt: () => Promise.resolve(ok(undefined)),
  };
}

interface FixtureOptions {
  readonly skillRuntime?: SkillRuntimePort;
  readonly checks?: "pending" | "success" | "failure";
  readonly reports?: Partial<Record<"code_reviewer" | "visual_reviewer", unknown>>;
  readonly postReviewDirty?: boolean;
  readonly evidenceVerified?: boolean;
  /** E102-3: overrides `evidenceIntegrity.verify`'s per-*call* result for one specific evidence
   * `source` -- lets a test simulate evidence that verified clean the first time (before any
   * reviewer provider ran) but no longer does the second time (after every provider finished),
   * exactly the "swapped mid-run" scenario `ReviewerPipeline.run`'s post-review re-verification
   * exists to catch. Every call to a source *not* in this map still falls back to
   * `evidenceVerified` (or its own default of `true`), unaffected. */
  readonly evidenceVerifiedSequenceBySource?: Readonly<Record<string, readonly boolean[]>>;
  readonly persistence?: "confirmed" | "unknown";
  readonly providerFailure?: Readonly<{
    role: "code_reviewer" | "visual_reviewer";
    error: DomainError;
    boundary: Extract<ProviderEvent, { kind: "quota_boundary" }>;
  }>;
}

function fixture(input: ReturnType<typeof request>, options: FixtureOptions = {}) {
  const calls: string[] = [];
  const providerRequests: ProviderRunRequest[] = [];
  const persistedJobs: ReturnType<typeof job>[] = [];
  let workingTreeReads = 0;
  const draft = {
    id: "PR_node_fixture",
    number: 42,
    url: "https://example.invalid/pull/42",
    state: "open",
    draft: true,
    baseBranch: "main",
    headBranch: worktree.branch,
    headSha,
    mergeability: "mergeable",
    autoMergeEnabled: false,
    updatedAt: now,
  } as const;
  const ready = { ...draft, draft: false } as const;
  const provider = (role: "code_reviewer" | "visual_reviewer") => ({
    inspectCapabilities: () =>
      Promise.resolve(
        ok({
          provider: role,
          cliVersion: "1",
          models: [role === "code_reviewer" ? "gpt-review" : "gemini-visual"],
          supportsResume: false,
          supportsStructuredEvents: true,
          supportsDynamicApproval: false,
          supportsVisualInput: role === "visual_reviewer",
        }),
      ),
    start: (providerRequest: ProviderRunRequest) => {
      calls.push(`provider:${role}`);
      providerRequests.push(providerRequest);
      const identityBlock = providerRequest.externalData.find(
        (block) => block.kind === "text" && block.source === "agent-team:review-identity",
      );
      if (identityBlock?.kind !== "text") throw new Error("Missing review identity evidence.");
      const output =
        options.reports?.[role] ??
        report(role, JSON.parse(identityBlock.content) as ReviewIdentity);
      if (options.providerFailure?.role === role) {
        return Promise.resolve(
          ok(
            handle(
              "partial output that must never become a report",
              [options.providerFailure.boundary],
              { outcome: "failed", error: options.providerFailure.error },
            ),
          ),
        );
      }
      return Promise.resolve(ok(handle(output)));
    },
  });
  const ports: ReviewerPipelinePorts = {
    ...(options.skillRuntime === undefined ? {} : { skillRuntime: options.skillRuntime }),
    git: {
      inspectWorktree: () => {
        calls.push("git:worktree");
        return Promise.resolve(
          ok({
            rootPath: project.localRepositoryPath,
            headSha,
            branch: worktree.branch,
            clean: !options.postReviewDirty || workingTreeReads === 0,
          }),
        );
      },
      inspectWorkingTree: () => {
        workingTreeReads += 1;
        calls.push("git:changes");
        return Promise.resolve(
          ok({
            headSha,
            changes:
              options.postReviewDirty && workingTreeReads > 1
                ? [
                    {
                      path: "src/changed.ts",
                      kind: "modified" as const,
                      mode: "file" as const,
                      staged: false,
                    },
                  ]
                : [],
          }),
        );
      },
      getEffectiveTreeDiff: () => {
        calls.push("git:diff");
        return Promise.resolve(ok(diff));
      },
    },
    sourceControl: {
      getChangeRequest: () => {
        calls.push("pr:get");
        return Promise.resolve(ok(draft));
      },
      getCommitChecks: () => {
        calls.push("ci:get");
        return Promise.resolve(
          ok({
            headSha,
            aggregate: options.checks ?? "success",
            checks: [
              {
                name: "quality",
                status: options.checks === "pending" ? "in_progress" : "completed",
                conclusion:
                  options.checks === "pending"
                    ? null
                    : options.checks === "failure"
                      ? "failure"
                      : "success",
              },
            ],
          }),
        );
      },
      markChangeRequestReady: () => {
        calls.push("pr:ready");
        return Promise.resolve(ok(ready));
      },
    },
    codeReviewer: provider("code_reviewer"),
    visualReviewer: provider("visual_reviewer"),
    toolDecisions: {
      decide: () =>
        Promise.resolve(ok({ response: "approve", pause: false, summary: "read-only" })),
    },
    evidenceIntegrity: {
      verify: (() => {
        const callCountBySource = new Map<string, number>();
        return (evidence: Parameters<ReviewerPipelinePorts["evidenceIntegrity"]["verify"]>[0]) => {
          calls.push(`evidence:${evidence.source}`);
          const sequence = options.evidenceVerifiedSequenceBySource?.[evidence.source];
          const callIndex = callCountBySource.get(evidence.source) ?? 0;
          callCountBySource.set(evidence.source, callIndex + 1);
          const verified =
            sequence === undefined
              ? (options.evidenceVerified ?? true)
              : (sequence[Math.min(callIndex, sequence.length - 1)] ?? true);
          return Promise.resolve(ok({ verified, byteLength: 1_024 }));
        };
      })(),
    },
    jobs: {
      update: (updated) => {
        calls.push("job:update");
        persistedJobs.push(updated);
        return Promise.resolve(ok({ durability: options.persistence ?? "confirmed" }));
      },
    },
    checkpoint: {
      preserve: () => {
        calls.push("checkpoint");
        return Promise.resolve(ok({ checkpointId: "checkpoint-review-limit" }));
      },
    },
  };
  return {
    pipeline: new ReviewerPipeline(ports),
    calls,
    providerRequests,
    persistedJobs,
  };
}

describe("ReviewerPipeline", () => {
  it("revalidates reviewer Skill content before PR mutation or Provider", async () => {
    const skillSnapshot = jobSkillSnapshotSchema.parse({
      schemaVersion: 1,
      jobId: "job_018f47d2-77a4-7cc1-8ef2-0123456789ab",
      projectId: project.id,
      skills: [],
      omitted: [],
    });
    const input = request(
      "code_review",
      {},
      {
        trustedConfig: trustedProjectConfigSchema.parse({
          ...config,
          skillPolicy: {
            catalogId: "fixture-catalog",
            catalogDigest: "4".repeat(64),
            allowlist: [],
          },
        }),
        skillSnapshots: { code_reviewer: skillSnapshot },
      },
    );
    const setup = fixture(input, {
      skillRuntime: {
        admit: () => Promise.resolve(ok(skillSnapshot)),
        materialize: () =>
          Promise.resolve(err(skillRuntimeFailure("content_changed", "fixture-skill"))),
      },
    });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({ state: "failed", stage: "request" });
    expect(setup.calls).toEqual([]);
  });

  it("reviewer-replay uses its external CAS budget instead of the exhausted historical Job counter", async () => {
    const input = request(
      "code_review",
      { reviewRuns: 3 },
      { attemptAccounting: "reviewer_replay" },
    );
    const setup = fixture(input);

    const outcome = await setup.pipeline.run(input.value);

    expect(outcome.state).toBe("approved");
    expect(setup.calls).toContain("provider:code_reviewer");
    expect(setup.calls).not.toContain("checkpoint");
    expect(setup.calls).not.toContain("job:update");
    expect(outcome.state === "approved" && outcome.job.attempts.reviewRuns).toBe(3);
  });

  it("propagates structured Claude wait evidence while discarding partial reviewer output", async () => {
    const input = request("code_review");
    const setup = fixture(input, {
      providerFailure: {
        role: "code_reviewer",
        error: domainError("rate_limited"),
        boundary: {
          kind: "quota_boundary",
          observedAt: now,
          confidence: "confirmed",
          bucket: "five_hour",
          resetAt: instant("2026-08-04T13:00:00.000Z"),
        },
      },
    });

    const outcome = await setup.pipeline.run(input.value);
    expect(outcome).toMatchObject({
      state: "failed",
      stage: "provider_run",
      error: { code: "rate_limited" },
      job: { attempts: { reviewRuns: 0 } },
      reviewWait: {
        confidence: "confirmed",
        bucket: "five_hour",
        headSha,
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("partial output");
    expect(setup.calls).not.toContain("job:update");
  });

  it("runs a fresh code review after exact-SHA CI success and increments only reviewRuns", async () => {
    const input = request("code_review", { ciFixRounds: 1 });
    const setup = fixture(input);
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "approved",
      job: { attempts: { ciFixRounds: 1, reviewerFixRounds: 0, reviewRuns: 1 } },
      changeRequest: { draft: false, headSha },
      reports: [{ role: "code_reviewer", verdict: "passed" }],
    });
    expect(setup.providerRequests).toHaveLength(1);
    expect(setup.providerRequests[0]).toMatchObject({
      role: "code_reviewer",
      model: "gpt-review",
      workingDirectory: worktree.path,
    });
    expect(setup.providerRequests[0]?.checkpoint).toBeUndefined();
    expect(setup.providerRequests[0]?.externalData.map((block) => block.source)).toEqual([
      "agent-team:review-identity",
      "agent-team:diff",
      "agent-team:ci",
      "known:compatibility",
    ]);
    const diffEvidence = setup.providerRequests[0]?.externalData.find(
      (block) => block.kind === "text" && block.source === "agent-team:diff",
    );
    expect(diffEvidence?.kind === "text" ? JSON.parse(diffEvidence.content) : undefined).toEqual(
      diff,
    );
    expect(setup.calls).toEqual([
      "pr:get",
      "ci:get",
      "git:worktree",
      "git:changes",
      "git:diff",
      "pr:ready",
      "provider:code_reviewer",
      "git:worktree",
      "git:changes",
      "job:update",
    ]);
  });

  it("requires both code and visual reviewers to pass in a dual review", async () => {
    const input = request("dual_review");
    const setup = fixture(input);
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "approved",
      reports: [
        { role: "code_reviewer", verdict: "passed" },
        { role: "visual_reviewer", verdict: "passed" },
      ],
    });
    expect(setup.providerRequests).toHaveLength(2);
    const visual = setup.providerRequests.find((run) => run.role === "visual_reviewer");
    expect(visual?.externalData.map((block) => block.source)).toEqual([
      "agent-team:review-identity",
      "agent-team:diff",
      "agent-team:ci",
      "artifact:screen",
      "agent-team:visual-manifest",
    ]);
    expect(setup.calls).toContain("evidence:artifact:screen");
  });

  it("E102-3: fails with evidence_changed when evidence verifies clean before the reviewer runs but not after", async () => {
    const input = request("dual_review");
    const setup = fixture(input, {
      evidenceVerifiedSequenceBySource: { "artifact:screen": [true, false] },
    });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "failed",
      stage: "evidence",
      error: { code: "evidence_changed" },
    });
    // Both reviewer providers still ran to completion (the swap is only detected afterward) --
    // this is deliberately *not* the same as the pre-run `#verifyEvidence` failing, which would
    // never reach `provider:*` at all.
    expect(setup.calls).toEqual(
      expect.arrayContaining(["provider:code_reviewer", "provider:visual_reviewer"]),
    );
    const verifyCallCount = setup.calls.filter(
      (call) => call === "evidence:artifact:screen",
    ).length;
    expect(verifyCallCount).toBe(2);
  });

  it("returns blocking findings when either half of a dual review rejects", async () => {
    const input = request("dual_review");
    const blocking = {
      severity: "blocking" as const,
      title: "Clipped content",
      description: "The evidence shows clipped content.",
      acceptanceCriteria: [firstCriterion(input.review.snapshot)],
      evidenceSources: ["artifact:screen"],
    };
    const setup = fixture(input, {
      reports: {
        visual_reviewer: report(
          "visual_reviewer",
          identityForRequest(input.value),
          "changes_requested",
          [blocking],
        ),
      },
    });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "changes_requested",
      findings: [blocking],
      job: { attempts: { reviewerFixRounds: 0, reviewRuns: 1 } },
    });
  });

  it("returns clarification separately from implementation findings", async () => {
    const input = request("code_review");
    const clarification = {
      severity: "clarification" as const,
      title: "Ambiguous AC",
      description: "The accepted boundary is unclear.",
      acceptanceCriteria: [firstCriterion(input.review.snapshot)],
      evidenceSources: [],
    };
    const setup = fixture(input, {
      reports: {
        code_reviewer: report("code_reviewer", input.review.identity, "clarification_required", [
          clarification,
        ]),
      },
    });

    await expect(setup.pipeline.run(input.value)).resolves.toMatchObject({
      state: "clarification_required",
      findings: [clarification],
    });
  });

  it("checkpoints before Provider work when the review-run limit is reached", async () => {
    const input = request("code_review", { reviewRuns: 3 });
    const setup = fixture(input);
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "checkpointed",
      checkpointId: "checkpoint-review-limit",
      job: input.value.job,
    });
    expect(setup.calls).toEqual(["pr:get", "ci:get", "checkpoint"]);
  });

  it("still runs the final review after both fixer budgets are exhausted", async () => {
    const input = request("code_review", {
      ciFixRounds: 2,
      reviewerFixRounds: 2,
      reviewRuns: 2,
    });
    const setup = fixture(input);

    await expect(setup.pipeline.run(input.value)).resolves.toMatchObject({
      state: "approved",
      job: { attempts: { ciFixRounds: 2, reviewerFixRounds: 2, reviewRuns: 3 } },
    });
    expect(setup.calls).toContain("provider:code_reviewer");
  });

  it("allows the third full review and preserves independent fix counters", async () => {
    const input = request("code_review", {
      ciFixRounds: 1,
      reviewerFixRounds: 1,
      reviewRuns: 2,
    });
    const setup = fixture(input);
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "approved",
      job: { attempts: { ciFixRounds: 1, reviewerFixRounds: 1, reviewRuns: 3 } },
    });
    expect(setup.persistedJobs[0]?.attempts.reviewRuns).toBe(3);
  });

  it.each(["pending", "failure"] as const)(
    "does not start Reviewer while CI is %s",
    async (aggregate) => {
      const input = request("code_review");
      const setup = fixture(input, { checks: aggregate });
      const outcome = await setup.pipeline.run(input.value);

      expect(outcome).toMatchObject({
        state: "not_ready",
        reason: aggregate === "pending" ? "ci_pending" : "ci_failed",
      });
      expect(setup.calls).toEqual(["pr:get", "ci:get"]);
    },
  );

  it("fails closed when visual Artifact bytes do not match trusted evidence", async () => {
    const input = request("visual_review");
    const setup = fixture(input, { evidenceVerified: false });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({ state: "failed", stage: "evidence" });
    expect(setup.calls).not.toContain("pr:ready");
    expect(setup.providerRequests).toHaveLength(0);
  });

  it("rejects a visual Artifact path that escapes the review Worktree", async () => {
    const input = request("visual_review");
    const artifact = input.value.evidence[0];
    if (artifact?.kind !== "file") throw new Error("Missing fixture artifact.");
    const escaped = {
      ...input.value,
      evidence: [{ ...artifact, path: "/tmp/outside/screen.png" }],
    } satisfies ReviewerPipelineRequest;
    const setup = fixture(input);
    const outcome = await setup.pipeline.run(escaped);

    expect(outcome).toMatchObject({ state: "failed", stage: "evidence" });
    expect(setup.calls).not.toContain("evidence:artifact:screen");
    expect(setup.calls).not.toContain("pr:ready");
  });

  it("rejects report references outside the evidence whitelist", async () => {
    const input = request("code_review");
    const blocking = {
      severity: "blocking" as const,
      title: "Untrusted handoff claim",
      description: "This improperly cites implementer conversation.",
      acceptanceCriteria: [],
      evidenceSources: ["implementer-handoff"],
    };
    const setup = fixture(input, {
      reports: {
        code_reviewer: report("code_reviewer", input.review.identity, "changes_requested", [
          blocking,
        ]),
      },
    });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({ state: "failed", stage: "report" });
    expect(setup.calls).not.toContain("job:update");
  });

  it.each(["acceptanceCriteria", "qualityChecks"] as const)(
    "rejects a passed report with incomplete %s coverage",
    async (field) => {
      const input = request("code_review");
      const complete = report("code_reviewer", input.review.identity);
      const incomplete = { ...complete, [field]: complete[field].slice(1) };
      const setup = fixture(input, { reports: { code_reviewer: incomplete } });
      const outcome = await setup.pipeline.run(input.value);

      expect(outcome).toMatchObject({ state: "failed", stage: "report" });
      expect(setup.calls).not.toContain("job:update");
    },
  );

  it("detects any Reviewer write even when Provider reports success", async () => {
    const input = request("code_review");
    const setup = fixture(input, { postReviewDirty: true });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "failed",
      stage: "post_review_worktree",
      error: { code: "permission_denied" },
    });
    expect(setup.calls).not.toContain("job:update");
  });

  it("fails closed when the completed review counter is not durably persisted", async () => {
    const input = request("code_review");
    const setup = fixture(input, { persistence: "unknown" });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({ state: "failed", stage: "attempt_persistence" });
  });

  it("rejects visual review without a Manifest before any external call", async () => {
    const input = request("visual_review");
    const invalid = {
      ...input.value,
      visualManifest: undefined,
    } as unknown as ReviewerPipelineRequest;
    const setup = fixture(input);
    const outcome = await setup.pipeline.run(invalid);

    expect(outcome).toMatchObject({ state: "failed", stage: "request" });
    expect(setup.calls).toEqual([]);
  });
});

/**
 * C015r decisions 2/3/4/5: the directive's controller-generated JSON skeleton, decision 3's
 * exactly-two-step deterministic syntax tolerance, and the resulting `reportFailureCategory`/
 * `rejectedOutput` propagation. `runReviewerProvider`/`tolerantParseCandidate`/
 * `classifyReportFailure` are not exported (private to reviewer-provider.ts) -- every case here goes
 * through the real, public `ReviewerPipeline.run()`, exactly as production does.
 */
describe("ReviewerPipeline report contract (C015r decisions 2/3/4/5)", () => {
  it("pins reviewer report contract v2 to its committed canonical digest", () => {
    expect(reviewerReportContractVersion).toBe(2);
    expect(computeReviewerReportContractDigest()).toBe(reviewerReportContractDigest);
  });

  it("directive omits a copyable line default and requires an exact unquoted positive integer or omission", async () => {
    const input = request("code_review");
    const setup = fixture(input);
    await setup.pipeline.run(input.value);

    const directive = setup.providerRequests[0]?.controllerDirective ?? "";
    expect(directive).not.toMatch(/\\"line\\"\s*:\s*\\"/u);
    expect(directive).not.toContain('"line": 1');
    expect(directive).toContain(
      'A finding may add a \\"line\\" key only when it also includes \\"path\\" and the exact line is known.',
    );
    expect(directive).toContain('A finding without \\"path\\" must omit \\"line\\" entirely.');
    expect(directive).toContain("unquoted positive-integer JSON number");
    expect(directive).toContain(
      '"path" and "line" are the only optional keys inside each findings[] object',
    );
    expect(directive).toContain(
      "Never encode line as a string, null, a range string, an array, or an object.",
    );
  });

  it.each([
    ["string", "42"],
    ["null", null],
    ["range", "12-14"],
    ["zero", 0],
    ["fraction", 1.5],
  ])("strict finding schema rejects %s line", (_name, line) => {
    expect(
      reviewFindingSchema.safeParse({
        severity: "advisory",
        title: "Finding",
        description: "Evidence",
        acceptanceCriteria: [acceptanceCriterion],
        evidenceSources: [],
        path: "src/file.ts",
        line,
      }).success,
    ).toBe(false);
  });

  it("strict finding schema accepts a positive integer with path and rejects line without path", () => {
    const base = {
      severity: "advisory",
      title: "Finding",
      description: "Evidence",
      acceptanceCriteria: [acceptanceCriterion],
      evidenceSources: [],
    };
    expect(reviewFindingSchema.safeParse({ ...base, path: "src/file.ts", line: 42 }).success).toBe(
      true,
    );
    expect(reviewFindingSchema.safeParse({ ...base, line: 42 }).success).toBe(false);
  });

  it("directive contains a JSON skeleton with the exact identity digests, the approved AC, every quality dimension for the role, and the real evidence source list", async () => {
    const input = request("code_review");
    const setup = fixture(input);
    await setup.pipeline.run(input.value);

    const directive = setup.providerRequests[0]?.controllerDirective ?? "";
    expect(directive).toContain(input.review.identity.requirementsDigest);
    expect(directive).toContain(input.review.identity.headSha);
    expect(directive).toContain(input.review.identity.diffDigest);
    expect(directive).toContain(acceptanceCriterion);
    for (const dimension of codeQualityDimensions) {
      expect(directive).toContain(dimension);
    }
    expect(directive).toContain("agent-team:review-identity");
    expect(directive).toContain("agent-team:diff");
    expect(directive).toContain("agent-team:ci");
    expect(directive).toContain("known:compatibility");
    // Decision 2's whole point: every enum's legal values spelled out inline, not just verdict's.
    expect(directive).toContain("passed | failed | clarification_required");
    expect(directive).toContain("passed | failed | not_applicable");
    expect(directive).toContain("blocking | advisory | clarification");
    // Decision 3's counterpart instruction: no framing at all, not even a Markdown fence.
    expect(directive).toContain(
      "no leading sentence, no trailing sentence, no Markdown code fence",
    );
    // Real-CLI acceptance run 1 (c015r-repro-run1) produced a finding with both acceptanceCriteria
    // and evidenceSources empty, which reviewFindingSchema's own superRefine rejects -- the
    // skeleton's findings placeholder now spells this cross-field constraint out explicitly.
    expect(directive).toContain(
      "every individual finding object inside it must have at least one entry in acceptanceCriteria OR at least one entry in evidenceSources",
    );
  });

  it("C028: directive no longer tells the model to read the repository itself, and instead tells it not to inspect .git", async () => {
    const input = request("code_review");
    const setup = fixture(input);
    await setup.pipeline.run(input.value);

    const directive = setup.providerRequests[0]?.controllerDirective ?? "";
    expect(directive).not.toContain("Read only the approved repository at base revision");
    expect(directive).toContain("controller-provided approved snapshot");
    expect(directive).toContain("do not inspect `.git`");
  });

  it("decision 3 step 2 tolerates a leading preamble sentence before an otherwise-valid JSON report", async () => {
    const input = request("code_review");
    const clean = report("code_reviewer", input.review.identity);
    const withPreamble = `Confirmed CI is green. Now producing the final review.\n\n${JSON.stringify(clean)}`;
    const setup = fixture(input, { reports: { code_reviewer: withPreamble } });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({ state: "approved" });
  });

  it("decision 3 step 1 tolerates a single Markdown fence layer wrapping an otherwise-valid JSON report", async () => {
    const input = request("code_review");
    const clean = report("code_reviewer", input.review.identity);
    const fenced = `\`\`\`json\n${JSON.stringify(clean)}\n\`\`\``;
    const setup = fixture(input, { reports: { code_reviewer: fenced } });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({ state: "approved" });
  });

  it("classifies a completely empty final message as empty_output, with no rejectedOutput to propagate", async () => {
    const input = request("code_review");
    const setup = fixture(input, { reports: { code_reviewer: "" } });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "failed",
      stage: "report",
      reportFailureCategory: "empty_output",
    });
    expect((outcome as { rejectedOutput?: string }).rejectedOutput).toBeUndefined();
  });

  it("classifies genuinely malformed JSON (even after both tolerance steps) as invalid_json and propagates the exact rejected text", async () => {
    const input = request("code_review");
    const garbage = "not json at all {{{";
    const setup = fixture(input, { reports: { code_reviewer: garbage } });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "failed",
      stage: "report",
      reportFailureCategory: "invalid_json",
      rejectedOutput: garbage,
    });
  });

  it("classifies an enum violation with no preamble/trailing content as enum_mismatch", async () => {
    const input = request("code_review");
    const clean = report("code_reviewer", input.review.identity);
    const badVerdict = { ...clean, verdict: "met" } as unknown as ReviewerReport;
    const setup = fixture(input, { reports: { code_reviewer: badVerdict } });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "failed",
      stage: "report",
      reportFailureCategory: "enum_mismatch",
    });
    expect((outcome as { rejectedOutput?: string }).rejectedOutput).toContain('"met"');
  });

  it("prioritizes preamble_or_trailing_content over the underlying enum issue when both are present", async () => {
    const input = request("code_review");
    const clean = report("code_reviewer", input.review.identity);
    const badVerdict = { ...clean, verdict: "met" } as unknown as ReviewerReport;
    const withPreamble = `Here is my review.\n\n${JSON.stringify(badVerdict)}`;
    const setup = fixture(input, { reports: { code_reviewer: withPreamble } });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "failed",
      stage: "report",
      reportFailureCategory: "preamble_or_trailing_content",
    });
  });

  it("classifies an evidence-whitelist violation (schema-valid, context-invalid) as context_mismatch", async () => {
    const input = request("code_review");
    const blocking = {
      severity: "blocking" as const,
      title: "Untrusted handoff claim",
      description: "This improperly cites implementer conversation.",
      acceptanceCriteria: [],
      evidenceSources: ["implementer-handoff"],
    };
    const setup = fixture(input, {
      reports: {
        code_reviewer: report("code_reviewer", input.review.identity, "changes_requested", [
          blocking,
        ]),
      },
    });
    const outcome = await setup.pipeline.run(input.value);

    expect(outcome).toMatchObject({
      state: "failed",
      stage: "report",
      reportFailureCategory: "context_mismatch",
    });
  });
});
