import { describe, expect, it } from "vitest";

import {
  GitHubReconcileAdapter,
  type GitHubReconcileReader,
} from "../../src/adapters/github/index.js";
import {
  LinearReconcileAdapter,
  type LinearIssueSnapshot,
  type LinearProjectContext,
  type LinearReconcileReader,
} from "../../src/adapters/linear/index.js";
import type {
  ChangeRequestSnapshot,
  CommitChecksSnapshot,
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

const sha = "0123456789abcdef0123456789abcdef01234567";
const previousSha = "fedcba9876543210fedcba9876543210fedcba98";

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_12345678-1234-1234-9234-123456789abc",
  displayName: "Fixture",
  localRepositoryPath: "/tmp/fixture",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team", projectId: "project" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});

const context = {
  team: { id: "team", name: "Team", key: "TM" },
  project: { id: "project", name: "Project" },
  catalog: {},
} as unknown as LinearProjectContext;

function linearIssue(overrides: Partial<LinearIssueSnapshot> = {}): LinearIssueSnapshot {
  return {
    id: "issue-id",
    identifier: "TM-1",
    title: "Fixture",
    updatedAt: instant("2026-08-04T12:01:00.000Z"),
    teamId: "team",
    projectId: "project",
    workStatus: "in_review",
    agentCondition: { status: "waiting", blockingReasons: [] },
    otherLabelIds: [],
    relations: [],
    comments: [],
    ...overrides,
  };
}

function changeRequest(overrides: Partial<ChangeRequestSnapshot> = {}): ChangeRequestSnapshot {
  return {
    id: "node-id",
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
    state: "open",
    draft: false,
    baseBranch: "main",
    headBranch: "task/fixture",
    headSha: sha,
    mergeability: "mergeable",
    autoMergeEnabled: false,
    updatedAt: instant("2026-08-04T12:01:00.000Z"),
    ...overrides,
  };
}

function checks(overrides: Partial<CommitChecksSnapshot> = {}): CommitChecksSnapshot {
  return { headSha: sha, aggregate: "success", checks: [], ...overrides };
}

class FakeLinearReader implements LinearReconcileReader {
  calls = 0;

  constructor(readonly result: Result<LinearIssueSnapshot, DomainError> = ok(linearIssue())) {}

  readIssue() {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

class FakeGitHubReader implements GitHubReconcileReader {
  readonly checkShas: string[] = [];

  constructor(
    readonly changeRequestResult: Result<ChangeRequestSnapshot, DomainError> = ok(changeRequest()),
    readonly checksResult: Result<CommitChecksSnapshot, DomainError> = ok(checks()),
  ) {}

  getChangeRequest() {
    return Promise.resolve(this.changeRequestResult);
  }

  getCommitChecks(_repository: unknown, headSha: string) {
    this.checkShas.push(headSha);
    return Promise.resolve(this.checksResult);
  }
}

describe("Linear authoritative reconcile read-back", () => {
  it("reconstructs missed status, Agent condition, and revision observations without mutation", async () => {
    const reader = new FakeLinearReader();
    const result = await new LinearReconcileAdapter(reader).readBack(context, "issue-id", {
      workStatus: "in_progress",
      agentCondition: { status: "executing", blockingReasons: [] },
      updatedAt: instant("2026-08-04T12:00:00.000Z"),
    });

    expect(result.ok && result.value.findings).toEqual([
      { kind: "work_status_changed", previous: "in_progress", current: "in_review" },
      {
        kind: "agent_condition_changed",
        previous: { status: "executing", blockingReasons: [] },
        current: { status: "waiting", blockingReasons: [] },
      },
      {
        kind: "issue_revision_changed",
        previous: "2026-08-04T12:00:00.000Z",
        current: "2026-08-04T12:01:00.000Z",
      },
    ]);
    expect(reader.calls).toBe(1);
  });

  it("returns no finding when local observation already matches authority", async () => {
    const issue = linearIssue();
    const result = await new LinearReconcileAdapter(new FakeLinearReader(ok(issue))).readBack(
      context,
      "issue-id",
      {
        workStatus: issue.workStatus,
        ...(issue.agentCondition === undefined ? {} : { agentCondition: issue.agentCondition }),
        updatedAt: issue.updatedAt,
      },
    );
    expect(result.ok && result.value.findings).toEqual([]);
  });

  it("honors a pre-aborted reconcile and propagates provider failures", async () => {
    const controller = new AbortController();
    controller.abort();
    const reader = new FakeLinearReader();
    const interrupted = await new LinearReconcileAdapter(reader).readBack(
      context,
      "issue-id",
      { workStatus: "in_progress" },
      { signal: controller.signal },
    );
    const failed = await new LinearReconcileAdapter(
      new FakeLinearReader(err(domainError("rate_limited"))),
    ).readBack(context, "issue-id", { workStatus: "in_progress" });

    expect(interrupted.ok ? "ok" : interrupted.error.code).toBe("interrupted");
    expect(reader.calls).toBe(0);
    expect(failed.ok ? "ok" : failed.error.code).toBe("rate_limited");
  });
});

describe("GitHub authoritative reconcile read-back", () => {
  it("classifies an unapproved merged Head as an out-of-process merge", async () => {
    const reader = new FakeGitHubReader(ok(changeRequest({ state: "merged" })));
    const result = await new GitHubReconcileAdapter(reader).readBack(
      { project, changeRequestId: "42" },
      { state: "open", draft: false, headSha: sha, checksAggregate: "success" },
    );

    expect(result.ok && result.value.findings).toEqual([
      { kind: "out_of_process_merge", headSha: sha },
    ]);
    expect(reader.checkShas).toEqual([sha]);
  });

  it("classifies a matching authorized Head as a missed merge event", async () => {
    const result = await new GitHubReconcileAdapter(
      new FakeGitHubReader(ok(changeRequest({ state: "merged" }))),
    ).readBack(
      { project, changeRequestId: "42" },
      {
        state: "open",
        draft: false,
        headSha: sha,
        checksAggregate: "success",
        mergeAuthorizationHeadSha: sha.toUpperCase(),
      },
    );

    expect(result.ok && result.value.findings).toEqual([
      { kind: "missed_merge_event", headSha: sha },
    ]);
  });

  it("reports a closed PR without converting it into issue cancellation", async () => {
    const result = await new GitHubReconcileAdapter(
      new FakeGitHubReader(ok(changeRequest({ state: "closed" }))),
    ).readBack({ project, changeRequestId: "42" }, { state: "open", draft: false, headSha: sha });

    expect(result.ok && result.value.findings).toEqual([
      { kind: "change_request_closed", previous: "open" },
    ]);
    expect(JSON.stringify(result)).not.toContain("cancel");
  });

  it("reports a manually reopened PR instead of silently accepting state drift", async () => {
    const result = await new GitHubReconcileAdapter(new FakeGitHubReader()).readBack(
      { project, changeRequestId: "42" },
      { state: "closed", draft: false, headSha: sha },
    );

    expect(result.ok && result.value.findings).toEqual([
      { kind: "change_request_reopened", previous: "closed" },
    ]);
  });

  it("rebuilds checks from the authoritative new Head and exposes all drift", async () => {
    const reader = new FakeGitHubReader(
      ok(changeRequest({ headSha: sha, draft: false })),
      ok(checks({ headSha: sha, aggregate: "failure" })),
    );
    const result = await new GitHubReconcileAdapter(reader).readBack(
      { project, changeRequestId: "42" },
      {
        state: "open",
        draft: true,
        headSha: previousSha,
        checksAggregate: "pending",
      },
    );

    expect(result.ok && result.value.findings).toEqual([
      { kind: "head_changed", previous: previousSha, current: sha },
      { kind: "draft_changed", previous: true, current: false },
      { kind: "checks_changed", previous: "pending", current: "failure", headSha: sha },
    ]);
    expect(reader.checkShas).toEqual([sha]);
  });

  it("propagates provider failures instead of returning partial false-green observations", async () => {
    const changeRequestFailure = await new GitHubReconcileAdapter(
      new FakeGitHubReader(err(domainError("unavailable"))),
    ).readBack({ project, changeRequestId: "42" }, { state: "open", draft: false, headSha: sha });
    const checksFailure = await new GitHubReconcileAdapter(
      new FakeGitHubReader(ok(changeRequest()), err(domainError("rate_limited"))),
    ).readBack({ project, changeRequestId: "42" }, { state: "open", draft: false, headSha: sha });
    const mismatchedChecks = await new GitHubReconcileAdapter(
      new FakeGitHubReader(ok(changeRequest()), ok(checks({ headSha: previousSha }))),
    ).readBack({ project, changeRequestId: "42" }, { state: "open", draft: false, headSha: sha });

    expect(changeRequestFailure.ok ? "ok" : changeRequestFailure.error.code).toBe("unavailable");
    expect(checksFailure.ok ? "ok" : checksFailure.error.code).toBe("rate_limited");
    expect(mismatchedChecks.ok ? "ok" : mismatchedChecks.error.code).toBe("external_failure");
  });
});
