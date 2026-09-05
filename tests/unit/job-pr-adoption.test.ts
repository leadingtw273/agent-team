import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileJobProgressStore,
  type JobProgressRecord,
} from "../../src/adapters/dispatch/job-progress-store.js";
import {
  appendPullRequestBackPointer,
  createPullRequestBackPointer,
} from "../../src/application/pipelines/index.js";
import {
  JobPrAdoptionCoordinator,
  type JobPrAdoptionDependencies,
  type JobPrAdoptionInput,
} from "../../src/cli/dispatch/job-pr-adoption.js";
import {
  createFixedClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  parseInstant,
} from "../../src/domain/foundation/index.js";
import { emptyAttemptCounters } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot, headShaSchema } from "../../src/domain/review/index.js";

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))),
);
const id = <S extends string>(s: S, v: string) => {
  const x = parseIdentifier(s, v);
  if (!x.ok) throw Error(x.error.code);
  return x.value;
};
const instant = (v: string) => {
  const x = parseInstant(v);
  if (!x.ok) throw Error(x.error.code);
  return x.value;
};
const now = instant("2026-09-05T03:00:00.000Z");
const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const issueId = id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const jobId = id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const leaseId = id("lease", "lease_018f47d2-77a4-7cc1-8ef2-0123456789ab");
const base = headShaSchema.parse("a".repeat(40));
const head = headShaSchema.parse("b".repeat(40));
const branch = `agent-team/${projectId}/${issueId}/${jobId}`;
const project = projectSchema.parse({
  schemaVersion: 1,
  id: projectId,
  displayName: "Adoption",
  localRepositoryPath: "/tmp/adoption",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team", projectId: "lp" },
  sourceControl: { provider: "github", repository: "o/r" },
});
const issue = issueSchema.parse({
  schemaVersion: 1,
  id: issueId,
  projectId,
  externalId: "LEA-200",
  title: "Adopt",
  goal: "Safely adopt",
  acceptanceCriteria: ["green"],
  inScope: ["src/feature.ts"],
  outOfScope: ["else"],
  dependencies: { kind: "none" },
  agentRole: "implementer",
  reviewRequirement: "code_review",
  humanSummary: { objective: "Adopt", outcome: "Existing PR", acceptance: "Green checks" },
  humanAcceptanceRequirement: "required",
  verificationLevel: "standard",
  changeRegions: [{ path: "src/feature.ts", coverage: "exact" }],
});
const req = createRequirementSnapshot(issue, now);
if (!req.ok) throw Error(req.error.code);
const digest = req.value.requirementsDigest;
const oldPolicy = {
  acceptanceRequirement: "required" as const,
  verificationLevel: "standard" as const,
  requirementDigest: "c".repeat(64),
  humanSummaryDigest: "d".repeat(64),
};
const oldAttempts = [
  {
    operationKey: "old",
    intent: "pr_comment" as const,
    identityDigest: "e".repeat(64),
    attempts: [{ ordinal: 1, preparedAt: now, outcome: "prepared" as const }],
  },
];
const pointer = createPullRequestBackPointer({
  schemaVersion: 1,
  projectId,
  issueId,
  jobId,
  branch,
});
if (!pointer.ok) throw Error(pointer.error.code);
const prBody = appendPullRequestBackPointer("Human PR", pointer.value);
if (!prBody.ok) throw Error(prBody.error.code);
const validPrBody: string = prBody.value;

function record(overrides: Record<string, unknown> = {}) {
  return {
    jobId,
    projectId,
    issueId,
    externalIssueId: issue.externalId,
    model: "gpt-5.6-terra",
    providerAssignments: {
      execution: { provider: "codex", model: "gpt-5.6-terra" },
      codeReview: { provider: "claude", model: "opus" },
    },
    stage: { kind: "paused", pauseReason: "scope_overrun" },
    branch,
    worktreePath: `/tmp/${jobId}`,
    baseRevision: base,
    humanDelivery: oldPolicy,
    controlFence: {
      leaseId,
      holderId: "old-holder",
      leaseEpoch: 1,
      ownershipEpoch: 0,
      state: "active",
    },
    mutationAttempts: oldAttempts,
    ...overrides,
  } as never;
}

async function harness(realStore = false, confirmed = true) {
  const root = await mkdtemp(join(tmpdir(), "adoption-"));
  dirs.push(root);
  const store = new FileJobProgressStore(join(root, "progress"), undefined, createFixedClock(now));
  const seeded = await store.compareAndSwap(jobId, null, record());
  if (!seeded.ok) throw Error(seeded.error.code);
  let current = seeded.value;
  const load = vi.fn(() => Promise.resolve(ok(current)));
  const compareAndSwap = vi.fn((_: unknown, rev: number, next: object) => {
    if (rev !== current.revision) return Promise.resolve(err(domainError("conflict")));
    current = { ...next, schemaVersion: 1, revision: rev + 1, updatedAt: now } as JobProgressRecord;
    return Promise.resolve(ok(current));
  });
  const progress = realStore ? store : { load, compareAndSwap };
  const events: string[] = [];
  const lease = {
    schemaVersion: 1,
    id: leaseId,
    jobId,
    issueId,
    holderId: "holder",
    acquiredAt: now,
    expiresAt: instant("2026-09-05T03:10:00.000Z"),
    revision: 0,
  };
  const pr = {
    id: "116",
    number: 116,
    url: "https://x/116",
    state: "open",
    draft: false,
    baseBranch: "main",
    headBranch: branch,
    headSha: head,
    mergeability: "mergeable",
    autoMergeEnabled: false,
    body: validPrBody,
    updatedAt: now,
  };
  const deps = {
    project,
    progress,
    jobs: {
      readAll: vi.fn(() =>
        Promise.resolve(
          ok([
            {
              schemaVersion: 1,
              id: jobId,
              projectId,
              issueId,
              createdAt: now,
              watchdogExtensionGranted: false,
              attempts: emptyAttemptCounters(),
            },
          ]),
        ),
      ),
    },
    admission: {
      load: vi.fn(() =>
        Promise.resolve(
          ok({ state: "active", jobId, projectId, issueId, externalIssueId: issue.externalId }),
        ),
      ),
    },
    issue: vi.fn(() => Promise.resolve(ok(issue))),
    workIssue: vi.fn(() =>
      Promise.resolve(
        ok({
          issue: { id: issueId, projectId, externalId: issue.externalId },
          workStatus: "in_progress",
        }),
      ),
    ),
    sourceControl: {
      getChangeRequest: vi.fn(() => Promise.resolve(ok(pr))),
      getCommitChecks: vi.fn(() =>
        Promise.resolve(
          ok({
            headSha: head,
            aggregate: "success",
            checks: [{ name: "test", status: "completed", conclusion: "success" }],
          }),
        ),
      ),
    },
    git: {
      getEffectiveTreeDiff: vi.fn(() =>
        Promise.resolve(
          ok([
            {
              status: "modified",
              before: { path: "src/feature.ts" },
              after: { path: "src/feature.ts" },
            },
          ]),
        ),
      ),
    },
    clock: createFixedClock(now),
    holderId: "holder",
    confirmed,
    leases: {
      acquire: vi.fn(() => {
        events.push("acquire");
        return Promise.resolve(ok({ value: lease }));
      }),
      renew: vi.fn(() => {
        events.push("renew");
        return Promise.resolve(ok({ value: lease }));
      }),
      release: vi.fn(() => {
        events.push("release");
        return Promise.resolve(ok(undefined));
      }),
    },
    bind: vi.fn((r: JobProgressRecord) => {
      events.push("bind");
      return Promise.resolve(ok(r));
    }),
    resume: vi.fn(() => {
      events.push("resume");
      return Promise.resolve({
        state: "resumed" as const,
        outcomes: [{ jobId, outcome: "completed" as const }],
      });
    }),
  };
  return {
    coordinator: new JobPrAdoptionCoordinator(deps as JobPrAdoptionDependencies),
    deps,
    store,
    seeded: seeded.value,
    events,
    pr,
    load,
    compareAndSwap,
  };
}
const input = { jobId, adoptPr: 116, expectHead: head, expectRequirementsDigest: digest };
const payload = (r: { message?: string }): Record<string, unknown> =>
  JSON.parse(r.message ?? "{}") as Record<string, unknown>;
function noAdoption(h: Awaited<ReturnType<typeof harness>>) {
  expect(h.deps.bind).not.toHaveBeenCalled();
  expect(h.deps.resume).not.toHaveBeenCalled();
  expect(h.compareAndSwap).not.toHaveBeenCalled();
}

describe("JobPrAdoptionCoordinator", () => {
  it.each([
    { adoptPr: 0, expectHead: head, expectRequirementsDigest: digest },
    { adoptPr: 116, expectHead: "bad", expectRequirementsDigest: digest },
    { adoptPr: 116, expectHead: head, expectRequirementsDigest: "bad" },
  ])("rejects invalid input before reads", async (bad) => {
    expect(
      payload(await new JobPrAdoptionCoordinator({} as never).run({ jobId, ...bad })),
    ).toMatchObject({ reason: "invalid_command_input" });
  });

  it("valid dry-run performs zero writes, lease, bind, or resume", async () => {
    const h = await harness();
    expect((await h.coordinator.run({ ...input, dryRun: true })).state).toBe("success");
    expect(h.deps.leases.acquire).not.toHaveBeenCalled();
    noAdoption(h);
  });

  it("uses the real atomic store once and preserves old policy, attempts, and base", async () => {
    const h = await harness(true);
    expect((await h.coordinator.run(input)).state).toBe("success");
    expect(h.deps.bind).toHaveBeenCalledOnce();
    expect(h.deps.resume).toHaveBeenCalledOnce();
    expect(h.events.indexOf("release")).toBeLessThan(h.events.indexOf("resume"));
    const saved = await h.store.load(jobId);
    expect(saved).toMatchObject({
      ok: true,
      value: {
        stage: { kind: "awaiting_review" },
        changeRequestId: "116",
        headSha: head,
        baseRevision: base,
        mutationAttempts: h.seeded.mutationAttempts,
        approvedScopeAdoption: {
          previousHumanDelivery: oldPolicy,
          changeRequestId: "116",
          headSha: head,
        },
      },
    });
    expect(saved.ok && saved.value?.humanDelivery?.requirementDigest).toBe(digest);
  });

  const matrix: [
    string,
    (h: Awaited<ReturnType<typeof harness>>) => void,
    string,
    Partial<JobPrAdoptionInput>?,
  ][] = [
    [
      "wrong stage",
      (h) => h.load.mockResolvedValue(ok({ ...h.seeded, stage: { kind: "ci_waiting" } })),
      "job_not_eligible",
    ],
    [
      "already bound",
      (h) => h.load.mockResolvedValue(ok({ ...h.seeded, changeRequestId: "1" })),
      "job_not_eligible",
    ],
    [
      "claim mismatch",
      (h) =>
        h.deps.admission.load.mockResolvedValue(
          ok({
            state: "active",
            jobId: id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ac"),
            projectId,
            issueId,
            externalIssueId: issue.externalId,
          }),
        ),
      "claim_mismatch",
    ],
    [
      "PR branch",
      (h) =>
        h.deps.sourceControl.getChangeRequest.mockResolvedValue(
          ok({ ...h.pr, headBranch: "wrong" }),
        ),
      "change_request_mismatch",
    ],
    [
      "PR head",
      (h) =>
        h.deps.sourceControl.getChangeRequest.mockResolvedValue(
          ok({ ...h.pr, headSha: headShaSchema.parse("f".repeat(40)) }),
        ),
      "change_request_mismatch",
    ],
    [
      "PR state",
      (h) =>
        h.deps.sourceControl.getChangeRequest.mockResolvedValue(ok({ ...h.pr, state: "closed" })),
      "change_request_mismatch",
    ],
    [
      "PR base",
      (h) =>
        h.deps.sourceControl.getChangeRequest.mockResolvedValue(ok({ ...h.pr, baseBranch: "dev" })),
      "change_request_mismatch",
    ],
    [
      "Linear canceled",
      (h) =>
        h.deps.workIssue.mockResolvedValue(
          ok({
            issue: { id: issueId, projectId, externalId: issue.externalId },
            workStatus: "canceled",
          }),
        ),
      "issue_state_mismatch",
    ],
    [
      "Linear completed",
      (h) =>
        h.deps.workIssue.mockResolvedValue(
          ok({
            issue: { id: issueId, projectId, externalId: issue.externalId },
            workStatus: "completed",
          }),
        ),
      "issue_state_mismatch",
    ],
    [
      "old requirements digest",
      () => undefined,
      "requirement_mismatch",
      { expectRequirementsDigest: "e".repeat(64) },
    ],
    [
      "empty diff",
      (h) => h.deps.git.getEffectiveTreeDiff.mockResolvedValue(ok([])),
      "effective_diff_invalid",
    ],
    [
      "outside allowed path",
      (h) =>
        h.deps.git.getEffectiveTreeDiff.mockResolvedValue(
          ok([{ status: "modified", before: { path: "README.md" }, after: { path: "README.md" } }]),
        ),
      "effective_diff_invalid",
    ],
    [
      "check non-green",
      (h) =>
        h.deps.sourceControl.getCommitChecks.mockResolvedValue(
          ok({ headSha: head, aggregate: "failure", checks: [] }),
        ),
      "ci_not_successful",
    ],
    [
      "backpointer",
      (h) => h.deps.sourceControl.getChangeRequest.mockResolvedValue(ok({ ...h.pr, body: "none" })),
      "backpointer_mismatch",
    ],
  ];
  it.each(matrix)(
    "rejects %s without adoption CAS/resume",
    async (_name, alter, reason, override) => {
      const h = await harness();
      alter(h);
      expect(payload(await h.coordinator.run({ ...input, ...override }))).toMatchObject({ reason });
      noAdoption(h);
    },
  );

  it("rejects confirmation false before lease/write", async () => {
    const h = await harness(false, false);
    expect(payload(await h.coordinator.run(input))).toMatchObject({
      reason: "confirmation_required",
    });
    expect(h.deps.leases.acquire).not.toHaveBeenCalled();
    noAdoption(h);
  });
  it("rejects CAS failure without resume", async () => {
    const h = await harness();
    h.compareAndSwap.mockResolvedValue(err(domainError("conflict")));
    expect(payload(await h.coordinator.run(input))).toMatchObject({
      reason: "adoption_write_failed",
    });
    expect(h.deps.resume).not.toHaveBeenCalled();
  });
  it("rejects second authority read drift before adoption CAS/resume", async () => {
    const h = await harness();
    h.deps.issue.mockResolvedValueOnce(ok(issue)).mockResolvedValueOnce(
      ok({
        ...issue,
        humanSummary: { objective: "Adopt", outcome: "drift", acceptance: "Green checks" },
      }),
    );
    expect(payload(await h.coordinator.run(input))).toMatchObject({ reason: "candidate_changed" });
    noAdoption(h);
  });
});
