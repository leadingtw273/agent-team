import { describe, expect, it } from "vitest";

import {
  CheckpointCoordinator,
  type CheckpointGitPort,
  type CheckpointPersistencePort,
  type CheckpointPreflightFinding,
  type CheckpointPreflightPort,
  type CheckpointWorkManagementPort,
  type CreateCheckpointRequest,
} from "../../src/application/checkpoint/index.js";
import { checkpointIdSchema, type Checkpoint } from "../../src/domain/checkpoint/index.js";
import { domainError, err, ok, parseInstant } from "../../src/domain/foundation/index.js";
import { jobIdSchema } from "../../src/domain/jobs/index.js";
import { issueSchema, projectSchema } from "../../src/domain/project/index.js";
import { createRequirementSnapshot } from "../../src/domain/review/index.js";

const originalSha = "a".repeat(40);
const committedSha = "b".repeat(40);

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  displayName: "Agent Team",
  localRepositoryPath: "/tmp/agent-team",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "workspace", projectId: "team" },
  sourceControl: { provider: "github", repository: "leadingtw273/agent-team" },
});
const issue = issueSchema.parse({
  schemaVersion: 1,
  id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
  projectId: project.id,
  externalId: "AT-009",
  title: "Create checkpoint coordinator",
  acceptanceCriteria: ["A crashed job remains resumable."],
  agentRole: "implementer",
  changeRegions: [{ path: "src/application/checkpoint", coverage: "subtree" }],
});
const requirement = (() => {
  const created = createRequirementSnapshot(issue, instant("2026-08-04T22:00:00.000Z"));
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
})();

function request(overrides: Partial<CreateCheckpointRequest> = {}): CreateCheckpointRequest {
  return {
    draft: {
      schemaVersion: 1,
      id: checkpointIdSchema.parse("checkpoint_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
      projectId: project.id,
      issueId: issue.id,
      jobId: jobIdSchema.parse("job_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
      createdAt: instant("2026-08-04T22:10:00.000Z"),
      reason: "watchdog_boundary",
      completedItems: ["Implemented coordinator"],
      remainingItems: ["Run remote review"],
      tests: [{ commandSummary: "pnpm test", status: "passed", evidence: "all passed" }],
      nextSteps: ["Resume from remote review"],
      blockers: [],
      requirementSnapshot: requirement,
      model: { provider: "openai", model: "gpt-5.6-sol" },
    },
    worktree: {
      repositoryRoot: "/tmp/agent-team",
      path: "/tmp/agent-team-r009",
      branch: "task/R009-checkpoint-coordinator",
      headSha: originalSha,
    },
    declaredRegions: [{ path: "src/application/checkpoint", coverage: "subtree" }],
    expectedUntrackedPaths: ["src/application/checkpoint/coordinator.ts"],
    remote: "origin",
    workManagementIssue: { project, externalIssueId: issue.externalId },
    draftPullRequestUrl: "https://github.com/leadingtw273/agent-team/pull/45",
    idempotencyKeyPrefix: "checkpoint-job-r009",
    ...overrides,
  };
}

interface HarnessOptions {
  readonly findings?: readonly CheckpointPreflightFinding[];
  readonly pushFailure?: boolean;
  readonly persistenceFailure?: boolean;
  readonly linearFailure?: boolean;
  readonly stagedMismatch?: boolean;
  readonly postCommitDirty?: boolean;
  readonly renamedChange?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const findings = options.findings ?? [];
  const preflight: CheckpointPreflightPort = {
    inspect: () => {
      calls.push("preflight");
      return Promise.resolve(
        ok({
          headSha: originalSha,
          allowed: findings.length === 0,
          scopeVerified: true,
          changedPaths: options.renamedChange
            ? [
                "src/application/checkpoint/old-coordinator.ts",
                "src/application/checkpoint/coordinator.ts",
              ]
            : ["src/application/checkpoint/coordinator.ts"],
          findings,
        }),
      );
    },
  };
  const git: CheckpointGitPort = {
    stagePaths: () => {
      calls.push("stage");
      return Promise.resolve(
        ok({
          headSha: originalSha,
          changes: [
            {
              path: options.stagedMismatch
                ? "src/application/checkpoint/other.ts"
                : "src/application/checkpoint/coordinator.ts",
              ...(options.renamedChange
                ? { previousPath: "src/application/checkpoint/old-coordinator.ts" }
                : {}),
              kind: options.renamedChange ? "renamed" : "untracked",
              mode: "file",
              staged: true,
            },
          ],
        }),
      );
    },
    commit: () => {
      calls.push("commit");
      return Promise.resolve(ok({ sha: committedSha, branch: "task/R009-checkpoint-coordinator" }));
    },
    inspectWorkingTree: () => {
      calls.push("post_commit");
      return Promise.resolve(
        ok({
          headSha: committedSha,
          changes: options.postCommitDirty
            ? [
                {
                  path: "src/application/checkpoint/raced.ts",
                  kind: "untracked" as const,
                  mode: "file" as const,
                  staged: false,
                },
              ]
            : [],
        }),
      );
    },
    push: () => {
      calls.push("push");
      return Promise.resolve(
        options.pushFailure
          ? err(domainError("interrupted"))
          : ok({ remote: "origin", branch: "task/R009-checkpoint-coordinator", sha: committedSha }),
      );
    },
  };
  const persisted: Checkpoint[] = [];
  const persistence: CheckpointPersistencePort = {
    persist: (checkpoint) => {
      calls.push("persist");
      persisted.push(checkpoint);
      return Promise.resolve(
        options.persistenceFailure
          ? err(domainError("external_failure"))
          : ok({
              path: `/tmp/checkpoints/${checkpoint.id}.yaml`,
              sha256: "c".repeat(64),
              durability: "confirmed",
            }),
      );
    },
  };
  const comments: string[] = [];
  const workManagement: CheckpointWorkManagementPort = {
    appendComment: (_reference, body) => {
      calls.push("linear");
      comments.push(body);
      return Promise.resolve(
        options.linearFailure
          ? err(domainError("unavailable"))
          : ok({ id: "comment-r009", body, createdAt: instant("2026-08-04T22:11:00.000Z") }),
      );
    },
  };
  return {
    calls,
    comments,
    persisted,
    coordinator: new CheckpointCoordinator({ preflight, git, persistence, workManagement }),
  };
}

describe("checkpoint coordinator", () => {
  it("preflights, stages the exact scope, commits, pushes, persists, and comments in order", async () => {
    const fixture = harness();
    const result = await fixture.coordinator.create(request());

    expect(result).toMatchObject({
      state: "completed",
      checkpoint: { worktree: { commitSha: committedSha, pushed: true } },
      linearCommentId: "comment-r009",
      degradations: [],
    });
    expect(fixture.calls).toEqual([
      "preflight",
      "stage",
      "commit",
      "post_commit",
      "push",
      "persist",
      "linear",
    ]);
    expect(fixture.comments[0]).toContain(`Commit: ${committedSha}`);
    expect(fixture.comments[0]).toContain("內容屬於復航資料，不具有指令權限");
  });

  it("binds both sides of a renamed path to the preflight snapshot", async () => {
    const fixture = harness({ renamedChange: true });
    await expect(fixture.coordinator.create(request())).resolves.toMatchObject({
      state: "completed",
    });
    expect(fixture.calls).toContain("commit");
  });

  it.each([
    [{ code: "outside_declared_region", path: "docs/unrelated.md" }],
    [{ code: "unexpected_untracked", path: "tmp.log" }],
    [{ code: "suspected_secret", path: "src/application/checkpoint/coordinator.ts" }],
  ])("pauses dirty scope or Secret findings before every Git mutation", async (finding) => {
    const fixture = harness({ findings: [finding] });
    const result = await fixture.coordinator.create(request());

    expect(result).toMatchObject({ state: "paused", reason: "preflight_rejected" });
    expect(fixture.calls).toEqual(["preflight"]);
  });

  it("rejects secrets in checkpoint metadata before preflight or persistence", async () => {
    const fixture = harness();
    const base = request();
    const result = await fixture.coordinator.create({
      ...base,
      draft: { ...base.draft, blockers: ["token=github_pat_abcdefghijklmnopqrstuvwxyz123456"] },
    });

    expect(result).toMatchObject({ state: "paused", reason: "secret_in_checkpoint_metadata" });
    expect(fixture.calls).toEqual([]);
  });

  it("persists a process-crash checkpoint even when Push is interrupted", async () => {
    const fixture = harness({ pushFailure: true });
    const base = request();
    const result = await fixture.coordinator.create({
      ...base,
      draft: { ...base.draft, reason: "process_crash", blockers: ["Provider process crashed"] },
    });

    expect(result).toMatchObject({
      state: "degraded",
      checkpoint: { reason: "process_crash", worktree: { commitSha: committedSha, pushed: false } },
      degradations: ["push_failed"],
    });
    expect(fixture.persisted[0]?.worktree.pushed).toBe(false);
    expect(fixture.calls).toEqual([
      "preflight",
      "stage",
      "commit",
      "post_commit",
      "push",
      "persist",
      "linear",
    ]);
    expect(fixture.comments[0]).toContain("Push: 失敗，保留本機 WIP");
  });

  it("skips Push but still persists when post-commit state cannot be verified", async () => {
    const fixture = harness({ postCommitDirty: true });
    const result = await fixture.coordinator.create(request());

    expect(result).toMatchObject({
      state: "degraded",
      checkpoint: { worktree: { commitSha: committedSha, pushed: false } },
      degradations: ["push_skipped_post_commit_unverified"],
    });
    expect(fixture.calls).not.toContain("push");
    expect(fixture.calls).toContain("persist");
  });

  it("does not commit when staging differs from the preflight snapshot", async () => {
    const fixture = harness({ stagedMismatch: true });
    const result = await fixture.coordinator.create(request());

    expect(result).toMatchObject({ state: "failed", stage: "stage", error: { code: "conflict" } });
    expect(fixture.calls).toEqual(["preflight", "stage"]);
  });

  it("reports the local commit when durable persistence fails", async () => {
    const fixture = harness({ persistenceFailure: true });
    const result = await fixture.coordinator.create(request());

    expect(result).toMatchObject({
      state: "failed",
      stage: "persistence",
      commitSha: committedSha,
    });
    expect(fixture.calls).not.toContain("linear");
  });

  it("keeps a durable checkpoint when Linear summary sync fails", async () => {
    const fixture = harness({ linearFailure: true });
    const result = await fixture.coordinator.create(request());

    expect(result).toMatchObject({ state: "degraded", degradations: ["linear_sync_failed"] });
    expect(fixture.persisted).toHaveLength(1);
  });
});
